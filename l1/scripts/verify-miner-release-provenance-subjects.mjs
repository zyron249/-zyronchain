#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyFile = process.argv[2] || path.resolve(process.cwd(), '../docs/miner-release-promotion.json');
const repositoryRoot = path.resolve(process.argv[3] || path.resolve(here, '../..'));
const baselineVerifier = path.join(here, 'verify-miner-release-promotion.mjs');

const baseline = spawnSync(process.execPath, [baselineVerifier, policyFile], { encoding: 'utf8' });
if (baseline.status !== 0) {
  process.stderr.write(baseline.stderr || baseline.stdout || 'baseline miner release promotion verification failed\n');
  process.exit(baseline.status ?? 1);
}

const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
const requiredPlatforms = ['windows', 'macos', 'linux'];
const sbomKeys = { windows: 'windowsSbom', macos: 'macosSbom', linux: 'linuxSbom' };
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
  console.log('miner release provenance evidence remains fail-closed');
  process.exit(0);
}

const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/`;
const exactBlobPrefix = `https://github.com/zyron249/-zyronchain/blob/${policy.sourceCommit}/`;
const allowedVerificationMethods = new Set(['slsa-provenance', 'build-attestation']);

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.join(',') !== expected.join(',')) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function runGit(args, options = {}) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: options.binary ? undefined : 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) {
    const detail = options.binary ? result.stderr?.toString('utf8') : result.stderr;
    throw new Error(`unable to resolve provenance evidence from exact source commit: ${detail || args.join(' ')}`);
  }
  return result.stdout;
}

function canonicalArtifactSubjects() {
  return requiredPlatforms.map((platform) => {
    const asset = policy.assets?.[platform];
    const sha256 = policy.assetSha256?.[platform];
    if (typeof asset !== 'string' || typeof sha256 !== 'string') {
      throw new Error(`missing ${platform} provenance artifact subject identity`);
    }
    if (!asset.startsWith(releasePrefix)) throw new Error(`invalid ${platform} promoted asset reference`);
    const name = asset.slice(releasePrefix.length);
    if (!name || name.includes('/') || name.includes('\\')) {
      throw new Error(`invalid ${platform} provenance artifact subject filename`);
    }
    return { platform, name, sha256 };
  });
}

function canonicalSbomSubjects(artifactSubjects) {
  return artifactSubjects.map((artifact) => {
    const evidence = policy.evidence?.[sbomKeys[artifact.platform]];
    if (typeof evidence !== 'string') throw new Error(`missing ${artifact.platform} SBOM provenance subject evidence`);
    const match = evidence.match(/#sha256=([0-9a-f]{64})$/);
    if (!match) throw new Error(`${artifact.platform} SBOM provenance subject requires exact sha256 binding`);
    const reference = evidence.slice(0, evidence.indexOf('#sha256='));
    const name = `${artifact.name}.sbom.cdx.json`;
    if (reference !== `${releasePrefix}${name}`) {
      throw new Error(`${artifact.platform} SBOM provenance subject must match exact promoted artifact SBOM`);
    }
    return { platform: artifact.platform, name, sha256: match[1] };
  });
}

function validateDistinctSubjects(artifactSubjects, sbomSubjects) {
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
}

function exactSourceBlob(relativePath) {
  const treeLine = runGit(['ls-tree', policy.sourceCommit, '--', relativePath]).trimEnd();
  const match = treeLine.match(/^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/);
  if (!match || match[3] !== relativePath) {
    throw new Error('provenance evidence must be a regular file in exact sourceCommit');
  }
  const bytes = runGit(['show', `${policy.sourceCommit}:${relativePath}`], { binary: true });
  if (!Buffer.isBuffer(bytes)) throw new Error('provenance evidence exact source blob unavailable');
  return bytes;
}

function readProvenanceEvidence(expectedArtifacts, expectedSboms) {
  const reference = policy.evidence?.provenance;
  if (typeof reference !== 'string') throw new Error('promotion requires provenance evidence');
  const digestMatch = reference.match(/#sha256=([0-9a-f]{64})$/);
  if (!digestMatch) throw new Error('provenance evidence must include exact sha256 digest binding');
  const url = reference.slice(0, reference.indexOf('#sha256='));
  if (!url.startsWith(exactBlobPrefix)) throw new Error('provenance evidence must bind to exact sourceCommit');
  const relativePath = url.slice(exactBlobPrefix.length);
  if (!/^evidence\/(?:provenance|attestation)\.json$/.test(relativePath)) {
    throw new Error('provenance evidence must use its canonical source-commit path');
  }

  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const rootPrefix = `${repositoryRoot}${path.sep}`;
  if (!absolutePath.startsWith(rootPrefix)) throw new Error('provenance evidence path escapes repository root');
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('provenance evidence must be a regular non-symlink working-tree file');
  }
  const workingBytes = readFileSync(absolutePath);
  const sourceBytes = exactSourceBlob(relativePath);
  const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
  if (sourceDigest !== digestMatch[1]) throw new Error('provenance evidence digest does not match exact sourceCommit blob bytes');
  const workingDigest = createHash('sha256').update(workingBytes).digest('hex');
  if (workingDigest !== sourceDigest) throw new Error('provenance working-tree evidence differs from exact sourceCommit blob');

  let document;
  try {
    document = JSON.parse(sourceBytes.toString('utf8'));
  } catch {
    throw new Error('provenance evidence must be valid JSON');
  }
  requireExactKeys(document, ['schemaVersion', 'releaseVersion', 'artifactSubjects', 'sbomSubjects', 'verification'], 'provenance evidence');
  if (document.schemaVersion !== 3) throw new Error('provenance evidence must use schemaVersion 3');
  if (document.releaseVersion !== policy.releaseVersion) throw new Error('provenance evidence release identity mismatch');
  if (!Array.isArray(document.artifactSubjects) || !Array.isArray(document.sbomSubjects)) {
    throw new Error('provenance evidence subjects must be arrays');
  }
  if (JSON.stringify(document.artifactSubjects) !== JSON.stringify(expectedArtifacts)) {
    throw new Error('provenance evidence artifact subjects do not match exact promoted artifacts');
  }
  if (JSON.stringify(document.sbomSubjects) !== JSON.stringify(expectedSboms)) {
    throw new Error('provenance evidence SBOM subjects do not match exact promoted SBOMs');
  }
  for (const [index, subject] of document.artifactSubjects.entries()) {
    requireExactKeys(subject, ['platform', 'name', 'sha256'], `provenance artifact subject ${index}`);
  }
  for (const [index, subject] of document.sbomSubjects.entries()) {
    requireExactKeys(subject, ['platform', 'name', 'sha256'], `provenance SBOM subject ${index}`);
  }
  requireExactKeys(document.verification, ['verified', 'method', 'tool'], 'provenance verification');
  if (document.verification.verified !== true) throw new Error('provenance verification must be explicitly true');
  if (!allowedVerificationMethods.has(document.verification.method)) {
    throw new Error('provenance evidence uses an unapproved verification method');
  }
  if (typeof document.verification.tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+:/-]{1,127}$/.test(document.verification.tool)) {
    throw new Error('provenance evidence requires a bounded verification tool identity');
  }
}

runGit(['cat-file', '-e', `${policy.sourceCommit}^{commit}`]);
const artifactSubjects = canonicalArtifactSubjects();
const sbomSubjects = canonicalSbomSubjects(artifactSubjects);
validateDistinctSubjects(artifactSubjects, sbomSubjects);
readProvenanceEvidence(artifactSubjects, sbomSubjects);

console.log('miner release provenance evidence is byte-bound to exact sourceCommit and verified artifact/SBOM subjects');
