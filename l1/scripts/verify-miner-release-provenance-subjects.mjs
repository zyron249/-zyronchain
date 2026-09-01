#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyFile = process.argv[2] || path.resolve(process.cwd(), '../docs/miner-release-promotion.json');
const baselineVerifier = path.join(here, 'verify-miner-release-promotion.mjs');

const baseline = spawnSync(process.execPath, [baselineVerifier, policyFile], { encoding: 'utf8' });
if (baseline.status !== 0) {
  process.stderr.write(baseline.stderr || baseline.stdout || 'baseline miner release promotion verification failed\n');
  process.exit(baseline.status ?? 1);
}

const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
const requiredPlatforms = ['windows', 'macos', 'linux'];
const sbomKeys = { windows: 'windowsSbom', macos: 'macosSbom', linux: 'linuxSbom' };
const digestFragment = /#sha256=([0-9a-f]{64})$/;
const activationRequested = [
  'publicMiningActivated',
  'releaseEligible',
  'platformSigningVerified',
  'provenanceVerified',
  'checksumsVerified',
  'sbomVerified',
  'immutableReleaseVerified',
  'publicationAllowed'
].some((field) => policy[field] === true) ||
  requiredPlatforms.some((platform) => policy.assets?.[platform] !== null) ||
  requiredPlatforms.some((platform) => policy.assetSha256?.[platform] !== null);

if (!activationRequested) {
  console.log('miner release provenance subject binding remains fail-closed');
  process.exit(0);
}

function canonicalArtifactSubjects() {
  return requiredPlatforms.map((platform) => {
    const asset = policy.assets?.[platform];
    const sha256 = policy.assetSha256?.[platform];
    if (typeof asset !== 'string' || typeof sha256 !== 'string') {
      throw new Error(`missing ${platform} provenance artifact subject identity`);
    }
    const name = asset.slice(asset.lastIndexOf('/') + 1);
    if (!name || name.includes('/') || name.includes('\\')) {
      throw new Error(`invalid ${platform} provenance artifact subject filename`);
    }
    return { platform, name, sha256 };
  });
}

function canonicalSbomSubjects(artifactSubjects) {
  const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/`;
  return artifactSubjects.map((artifact) => {
    const evidence = policy.evidence?.[sbomKeys[artifact.platform]];
    if (typeof evidence !== 'string') throw new Error(`missing ${artifact.platform} SBOM provenance subject evidence`);
    const match = evidence.match(digestFragment);
    if (!match) throw new Error(`${artifact.platform} SBOM provenance subject requires exact sha256 binding`);
    const reference = evidence.slice(0, evidence.length - match[0].length);
    const name = `${artifact.name}.sbom.cdx.json`;
    if (reference !== `${releasePrefix}${name}`) {
      throw new Error(`${artifact.platform} SBOM provenance subject must match exact promoted artifact SBOM`);
    }
    return { platform: artifact.platform, name, sha256: match[1] };
  });
}

const artifactSubjects = canonicalArtifactSubjects();
const sbomSubjects = canonicalSbomSubjects(artifactSubjects);
if (new Set(artifactSubjects.map((subject) => subject.name)).size !== requiredPlatforms.length) {
  throw new Error('provenance artifact subjects must use distinct canonical filenames');
}
if (new Set(artifactSubjects.map((subject) => subject.sha256)).size !== requiredPlatforms.length) {
  throw new Error('provenance artifact subjects must use distinct platform digests');
}
if (new Set(sbomSubjects.map((subject) => subject.name)).size !== requiredPlatforms.length) {
  throw new Error('provenance SBOM subjects must use distinct canonical filenames');
}
if (new Set(sbomSubjects.map((subject) => subject.sha256)).size !== requiredPlatforms.length) {
  throw new Error('provenance SBOM subjects must use distinct platform digests');
}
const artifactDigests = new Set(artifactSubjects.map((subject) => subject.sha256));
for (const subject of sbomSubjects) {
  if (artifactDigests.has(subject.sha256)) throw new Error('provenance SBOM subject must not alias promoted artifact bytes');
}

const provenance = policy.evidence?.provenance;
if (typeof provenance !== 'string') throw new Error('promotion requires provenance evidence');
const digestMatch = provenance.match(digestFragment);
if (!digestMatch) throw new Error('provenance evidence must include exact sha256 digest binding');

const canonicalDocument = `${JSON.stringify({
  schemaVersion: 2,
  releaseVersion: policy.releaseVersion,
  sourceCommit: policy.sourceCommit,
  artifactSubjects,
  sbomSubjects
})}\n`;
const expectedDigest = createHash('sha256').update(canonicalDocument, 'utf8').digest('hex');
if (digestMatch[1] !== expectedDigest) {
  throw new Error('provenance evidence digest does not bind the exact promoted artifact and per-platform SBOM subjects');
}

console.log('miner release provenance binds promoted artifacts and per-platform SBOM subjects');
