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
const platforms = ['windows', 'macos', 'linux'];
const sbomEvidenceFields = { windows: 'windowsSbom', macos: 'macosSbom', linux: 'linuxSbom' };
const activationRequested = ['publicMiningActivated','releaseEligible','platformSigningVerified','provenanceVerified','checksumsVerified','immutableReleaseVerified','publicationAllowed','sbomVerified']
  .some((field) => policy[field] === true) || platforms.some((p) => policy.assets?.[p] !== null) || platforms.some((p) => policy.assetSha256?.[p] !== null);
if (!activationRequested) {
  console.log('miner immutable-release subject binding remains fail-closed');
  process.exit(0);
}

const exactBlobPrefix = `https://github.com/zyron249/-zyronchain/blob/${policy.sourceCommit}/`;
const allowedVerificationMethods = new Set(['github-release-immutable', 'release-asset-verification']);

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.join(',') !== expected.join(',')) throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
}

function runGit(args, options = {}) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], { encoding: options.binary ? undefined : 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = options.binary ? result.stderr?.toString('utf8') : result.stderr;
    throw new Error(`unable to resolve immutable-release evidence from exact source commit: ${detail || args.join(' ')}`);
  }
  return result.stdout;
}

function exactSourceBlob(relativePath) {
  const treeLine = runGit(['ls-tree', policy.sourceCommit, '--', relativePath]).trimEnd();
  const match = treeLine.match(/^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/);
  if (!match || match[3] !== relativePath) throw new Error('immutable-release evidence must be a regular file in exact sourceCommit');
  const bytes = runGit(['show', `${policy.sourceCommit}:${relativePath}`], { binary: true });
  if (!Buffer.isBuffer(bytes)) throw new Error('immutable-release evidence exact source blob unavailable');
  return bytes;
}

const subjects = platforms.map((platform) => {
  const asset = policy.assets?.[platform];
  const sha256 = policy.assetSha256?.[platform];
  if (typeof asset !== 'string' || typeof sha256 !== 'string') throw new Error(`missing ${platform} immutable-release subject identity`);
  const name = asset.slice(asset.lastIndexOf('/') + 1);
  if (!name || name.includes('/') || name.includes('\\')) throw new Error(`invalid ${platform} immutable-release subject filename`);
  const sbomEvidence = policy.evidence?.[sbomEvidenceFields[platform]];
  if (typeof sbomEvidence !== 'string') throw new Error(`missing ${platform} SBOM evidence for immutable-release binding`);
  const sbomMatch = sbomEvidence.match(/\/([^/#]+)#sha256=([0-9a-f]{64})$/);
  if (!sbomMatch) throw new Error(`${platform} SBOM evidence must use an immutable filename and exact sha256 digest binding`);
  const sbomName = sbomMatch[1];
  const expectedSbomName = `${name}.sbom.cdx.json`;
  if (sbomName !== expectedSbomName) throw new Error(`${platform} SBOM evidence filename does not match promoted artifact`);
  return { platform, name, sha256, sbom: { name: sbomName, sha256: sbomMatch[2] } };
});
if (new Set(subjects.map((s) => s.name)).size !== platforms.length) throw new Error('immutable-release subjects must use distinct artifact filenames');
if (new Set(subjects.map((s) => s.sha256)).size !== platforms.length) throw new Error('immutable-release subjects must use distinct artifact digests');
if (new Set(subjects.map((s) => s.sbom.name)).size !== platforms.length) throw new Error('immutable-release subjects must use distinct SBOM filenames');
if (new Set(subjects.map((s) => s.sbom.sha256)).size !== platforms.length) throw new Error('immutable-release subjects must use distinct SBOM digests');
const artifactDigests = new Set(subjects.map((s) => s.sha256));
if (subjects.some((s) => artifactDigests.has(s.sbom.sha256))) throw new Error('immutable-release SBOM digests must not alias promoted artifact digests');

const evidence = policy.evidence?.immutableRelease;
if (typeof evidence !== 'string') throw new Error('promotion requires immutableRelease evidence');
const digestMatch = evidence.match(/#sha256=([0-9a-f]{64})$/);
if (!digestMatch) throw new Error('immutableRelease evidence must include exact sha256 digest binding');
const url = evidence.slice(0, evidence.indexOf('#sha256='));
if (url !== `${exactBlobPrefix}evidence/immutable-release.json`) throw new Error('immutableRelease evidence must bind the canonical file at exact sourceCommit');
const relativePath = 'evidence/immutable-release.json';
const absolutePath = path.resolve(repositoryRoot, relativePath);
const rootPrefix = `${repositoryRoot}${path.sep}`;
if (!absolutePath.startsWith(rootPrefix)) throw new Error('immutableRelease evidence path escapes repository root');
const stat = lstatSync(absolutePath);
if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('immutableRelease evidence must be a regular non-symlink working-tree file');
const workingBytes = readFileSync(absolutePath);
const sourceBytes = exactSourceBlob(relativePath);
const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
if (sourceDigest !== digestMatch[1]) throw new Error('immutableRelease evidence digest does not match exact sourceCommit blob bytes');
if (createHash('sha256').update(workingBytes).digest('hex') !== sourceDigest) throw new Error('immutableRelease working-tree evidence differs from exact sourceCommit blob');

let document;
try { document = JSON.parse(sourceBytes.toString('utf8')); } catch { throw new Error('immutableRelease evidence must be valid JSON'); }
requireExactKeys(document, ['schemaVersion', 'releaseVersion', 'subjects', 'verification'], 'immutableRelease evidence');
if (document.schemaVersion !== 3) throw new Error('immutableRelease evidence must use schemaVersion 3');
if (document.releaseVersion !== policy.releaseVersion) throw new Error('immutableRelease evidence release identity mismatch');
if (!Array.isArray(document.subjects) || JSON.stringify(document.subjects) !== JSON.stringify(subjects)) throw new Error('immutableRelease evidence subjects do not match exact promoted artifact/SBOM subjects');
for (const [index, subject] of document.subjects.entries()) {
  requireExactKeys(subject, ['platform', 'name', 'sha256', 'sbom'], `immutableRelease subject ${index}`);
  requireExactKeys(subject.sbom, ['name', 'sha256'], `immutableRelease SBOM subject ${index}`);
}
requireExactKeys(document.verification, ['verified', 'method', 'tool'], 'immutableRelease verification');
if (document.verification.verified !== true) throw new Error('immutableRelease verification must be explicitly true');
if (!allowedVerificationMethods.has(document.verification.method)) throw new Error('immutableRelease evidence uses an unapproved verification method');
if (typeof document.verification.tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+:/-]{1,127}$/.test(document.verification.tool)) throw new Error('immutableRelease evidence requires a bounded verification tool identity');

runGit(['cat-file', '-e', `${policy.sourceCommit}^{commit}`]);
console.log('miner immutable-release evidence is byte-bound to exact sourceCommit with explicit verified artifact/SBOM subjects');
