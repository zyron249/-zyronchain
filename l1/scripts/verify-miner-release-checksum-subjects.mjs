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
const activationRequested = [
  'publicMiningActivated',
  'releaseEligible',
  'platformSigningVerified',
  'provenanceVerified',
  'checksumsVerified',
  'immutableReleaseVerified',
  'publicationAllowed'
].some((field) => policy[field] === true) ||
  policy.sbomVerified === true ||
  requiredPlatforms.some((platform) => policy.assets?.[platform] !== null) ||
  requiredPlatforms.some((platform) => policy.assetSha256?.[platform] !== null);

if (!activationRequested) {
  console.log('miner release checksum subject binding remains fail-closed');
  process.exit(0);
}

function canonicalArtifactSubjects() {
  return requiredPlatforms.map((platform) => {
    const asset = policy.assets[platform];
    const sha256 = policy.assetSha256[platform];
    if (typeof asset !== 'string' || typeof sha256 !== 'string') {
      throw new Error(`missing ${platform} checksum artifact subject identity`);
    }
    const name = asset.slice(asset.lastIndexOf('/') + 1);
    if (!name || name.includes('/') || name.includes('\\')) {
      throw new Error(`invalid ${platform} checksum artifact subject filename`);
    }
    return { platform, name, sha256 };
  });
}

function canonicalSbomSubjects(artifactSubjects) {
  const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/`;
  return requiredPlatforms.map((platform, index) => {
    const evidenceName = `${platform}Sbom`;
    const reference = policy.evidence?.[evidenceName];
    if (typeof reference !== 'string') throw new Error(`missing ${platform} checksum SBOM subject identity`);
    const digestMatch = reference.match(/#sha256=([0-9a-f]{64})$/);
    if (!digestMatch) throw new Error(`${platform} checksum SBOM evidence must include exact sha256 digest binding`);
    const url = reference.slice(0, reference.length - digestMatch[0].length);
    const expectedName = `${artifactSubjects[index].name}.sbom.cdx.json`;
    const expectedUrl = `${releasePrefix}${expectedName}`;
    if (url !== expectedUrl) throw new Error(`${platform} checksum SBOM subject must use the canonical same-release asset path`);
    return { platform, name: expectedName, sha256: digestMatch[1] };
  });
}

const artifactSubjects = canonicalArtifactSubjects();
if (new Set(artifactSubjects.map((subject) => subject.name)).size !== requiredPlatforms.length) {
  throw new Error('checksum artifact subjects must use distinct canonical filenames');
}
if (new Set(artifactSubjects.map((subject) => subject.sha256)).size !== requiredPlatforms.length) {
  throw new Error('checksum artifact subjects must use distinct platform digests');
}

const sbomSubjects = canonicalSbomSubjects(artifactSubjects);
if (new Set(sbomSubjects.map((subject) => subject.name)).size !== requiredPlatforms.length) {
  throw new Error('checksum SBOM subjects must use distinct canonical filenames');
}
if (new Set(sbomSubjects.map((subject) => subject.sha256)).size !== requiredPlatforms.length) {
  throw new Error('checksum SBOM subjects must use distinct platform digests');
}
const artifactDigests = new Set(artifactSubjects.map((subject) => subject.sha256));
for (const subject of sbomSubjects) {
  if (artifactDigests.has(subject.sha256)) {
    throw new Error(`${subject.platform} checksum SBOM digest must not alias a promoted artifact digest`);
  }
}

const checksums = policy.evidence?.checksums;
if (typeof checksums !== 'string') throw new Error('promotion requires checksum evidence');
const digestMatch = checksums.match(/#sha256=([0-9a-f]{64})$/);
if (!digestMatch) throw new Error('checksum evidence must include exact sha256 digest binding');

const canonicalDocument = `${JSON.stringify({
  schemaVersion: 2,
  releaseVersion: policy.releaseVersion,
  sourceCommit: policy.sourceCommit,
  artifactSubjects,
  sbomSubjects
})}\n`;
const expectedDigest = createHash('sha256').update(canonicalDocument, 'utf8').digest('hex');
if (digestMatch[1] !== expectedDigest) {
  throw new Error('checksum evidence digest does not bind the exact Windows, macOS and Linux artifact and SBOM subjects');
}

console.log('miner release checksum evidence binds all promoted artifact and SBOM subjects');
