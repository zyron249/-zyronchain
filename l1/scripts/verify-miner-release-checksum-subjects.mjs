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
  console.log('miner release checksum evidence remains fail-closed');
  process.exit(0);
}

const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/`;
const exactBlobPrefix = `https://github.com/zyron249/-zyronchain/blob/${policy.sourceCommit}/`;
const evidencePath = 'evidence/checksums.json';
const allowedVerificationMethods = new Set(['sha256sum-manifest', 'release-checksum-verification']);

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
    throw new Error(`unable to resolve checksum evidence from exact source commit: ${detail || args.join(' ')}`);
  }
  return result.stdout;
}

function exactSourceBlob(relativePath) {
  const treeLine = runGit(['ls-tree', policy.sourceCommit, '--', relativePath]).trimEnd();
  const match = treeLine.match(/^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/);
  if (!match || match[3] !== relativePath) throw new Error('checksum evidence must be a regular file in exact sourceCommit');
  const bytes = runGit(['show', `${policy.sourceCommit}:${relativePath}`], { binary: true });
  if (!Buffer.isBuffer(bytes)) throw new Error('checksum evidence exact source blob unavailable');
  return bytes;
}

function canonicalArtifactSubjects() {
  return requiredPlatforms.map((platform) => {
    const asset = policy.assets?.[platform];
    const sha256 = policy.assetSha256?.[platform];
    if (typeof asset !== 'string' || typeof sha256 !== 'string') throw new Error(`missing ${platform} checksum artifact subject identity`);
    const expectedPrefix = releasePrefix;
    if (!asset.startsWith(expectedPrefix)) throw new Error(`${platform} checksum artifact must use canonical same-release asset path`);
    const name = asset.slice(expectedPrefix.length);
    if (!name || name.includes('/') || name.includes('\\')) throw new Error(`invalid ${platform} checksum artifact subject filename`);
    return { platform, name, sha256 };
  });
}

function canonicalSbomSubjects(artifactSubjects) {
  return requiredPlatforms.map((platform, index) => {
    const reference = policy.evidence?.[`${platform}Sbom`];
    if (typeof reference !== 'string') throw new Error(`missing ${platform} checksum SBOM subject identity`);
    const digestMatch = reference.match(/#sha256=([0-9a-f]{64})$/);
    if (!digestMatch) throw new Error(`${platform} checksum SBOM evidence must include exact sha256 digest binding`);
    const url = reference.slice(0, reference.length - digestMatch[0].length);
    const expectedName = `${artifactSubjects[index].name}.sbom.cdx.json`;
    if (url !== `${releasePrefix}${expectedName}`) throw new Error(`${platform} checksum SBOM subject must use canonical same-release asset path`);
    return { platform, name: expectedName, sha256: digestMatch[1] };
  });
}

const artifactSubjects = canonicalArtifactSubjects();
const sbomSubjects = canonicalSbomSubjects(artifactSubjects);
if (new Set(artifactSubjects.map((s) => s.name)).size !== requiredPlatforms.length) throw new Error('checksum artifact subjects must use distinct canonical filenames');
if (new Set(artifactSubjects.map((s) => s.sha256)).size !== requiredPlatforms.length) throw new Error('checksum artifact subjects must use distinct platform digests');
if (new Set(sbomSubjects.map((s) => s.name)).size !== requiredPlatforms.length) throw new Error('checksum SBOM subjects must use distinct canonical filenames');
if (new Set(sbomSubjects.map((s) => s.sha256)).size !== requiredPlatforms.length) throw new Error('checksum SBOM subjects must use distinct platform digests');
const artifactDigests = new Set(artifactSubjects.map((s) => s.sha256));
if (sbomSubjects.some((s) => artifactDigests.has(s.sha256))) throw new Error('checksum SBOM digests must not alias promoted artifact digests');

const checksums = policy.evidence?.checksums;
if (typeof checksums !== 'string') throw new Error('promotion requires checksum verification evidence');
const digestMatch = checksums.match(/#sha256=([0-9a-f]{64})$/);
if (!digestMatch) throw new Error('checksum evidence must include exact sha256 digest binding');
const url = checksums.slice(0, checksums.length - digestMatch[0].length);
if (url !== `${exactBlobPrefix}${evidencePath}`) throw new Error('checksum evidence must bind canonical evidence/checksums.json at exact sourceCommit');

const absolutePath = path.resolve(repositoryRoot, evidencePath);
if (!absolutePath.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('checksum evidence path escapes repository root');
const stat = lstatSync(absolutePath);
if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('checksum evidence must be a regular non-symlink working-tree file');
const workingBytes = readFileSync(absolutePath);
const sourceBytes = exactSourceBlob(evidencePath);
const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
if (sourceDigest !== digestMatch[1]) throw new Error('checksum evidence digest does not match exact sourceCommit blob bytes');
if (createHash('sha256').update(workingBytes).digest('hex') !== sourceDigest) throw new Error('checksum working-tree evidence differs from exact sourceCommit blob');

let document;
try { document = JSON.parse(sourceBytes.toString('utf8')); } catch { throw new Error('checksum evidence must be valid JSON'); }
requireExactKeys(document, ['schemaVersion', 'releaseVersion', 'artifactSubjects', 'sbomSubjects', 'checksumAsset', 'verification'], 'checksum evidence');
if (document.schemaVersion !== 3) throw new Error('checksum evidence must use schemaVersion 3');
if (document.releaseVersion !== policy.releaseVersion) throw new Error('checksum evidence release identity mismatch');
if (!Array.isArray(document.artifactSubjects) || JSON.stringify(document.artifactSubjects) !== JSON.stringify(artifactSubjects)) throw new Error('checksum evidence artifact subjects do not match promoted artifacts');
if (!Array.isArray(document.sbomSubjects) || JSON.stringify(document.sbomSubjects) !== JSON.stringify(sbomSubjects)) throw new Error('checksum evidence SBOM subjects do not match promoted SBOMs');
for (const [index, subject] of document.artifactSubjects.entries()) requireExactKeys(subject, ['platform', 'name', 'sha256'], `checksum artifact subject ${index}`);
for (const [index, subject] of document.sbomSubjects.entries()) requireExactKeys(subject, ['platform', 'name', 'sha256'], `checksum SBOM subject ${index}`);
requireExactKeys(document.checksumAsset, ['name', 'url', 'sha256'], 'checksum asset');
if (document.checksumAsset.name !== 'SHA256SUMS') throw new Error('checksum evidence must bind canonical SHA256SUMS asset name');
if (document.checksumAsset.url !== `${releasePrefix}SHA256SUMS`) throw new Error('checksum evidence must bind canonical same-release SHA256SUMS asset URL');
if (typeof document.checksumAsset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(document.checksumAsset.sha256)) throw new Error('checksum evidence requires exact SHA256SUMS byte digest');
if (artifactDigests.has(document.checksumAsset.sha256) || sbomSubjects.some((s) => s.sha256 === document.checksumAsset.sha256)) throw new Error('SHA256SUMS digest must not alias promoted artifact or SBOM bytes');
requireExactKeys(document.verification, ['verified', 'method', 'tool'], 'checksum verification');
if (document.verification.verified !== true) throw new Error('checksum verification must be explicitly true');
if (!allowedVerificationMethods.has(document.verification.method)) throw new Error('checksum evidence uses an unapproved verification method');
if (typeof document.verification.tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+:/-]{1,127}$/.test(document.verification.tool)) throw new Error('checksum evidence requires a bounded verification tool identity');

runGit(['cat-file', '-e', `${policy.sourceCommit}^{commit}`]);
console.log('miner checksum verification evidence is byte-bound to exact sourceCommit with explicit verified artifact/SBOM/SHA256SUMS subjects');
