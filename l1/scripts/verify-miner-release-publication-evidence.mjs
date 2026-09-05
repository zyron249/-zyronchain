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
const evidencePath = 'evidence/publication.json';
const allowedMethods = new Set(['publication-review', 'release-publication-verification']);
const digestFragment = /#sha256=([0-9a-f]{64})$/;

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.join(',') !== expected.join(',')) throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
}
function runGit(args, binary = false) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], { encoding: binary ? undefined : 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`unable to resolve publication evidence from exact source commit: ${(binary ? result.stderr?.toString('utf8') : result.stderr) || args.join(' ')}`);
  return result.stdout;
}
function exactSourceBlob(relativePath) {
  const line = runGit(['ls-tree', policy.sourceCommit, '--', relativePath]).trimEnd();
  const match = line.match(/^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/);
  if (!match || match[3] !== relativePath) throw new Error('publication evidence must be a regular file in exact sourceCommit');
  const bytes = runGit(['show', `${policy.sourceCommit}:${relativePath}`], true);
  if (!Buffer.isBuffer(bytes)) throw new Error('publication exact source blob unavailable');
  return bytes;
}

const activationRequested = ['publicMiningActivated','releaseEligible','platformSigningVerified','provenanceVerified','checksumsVerified','immutableReleaseVerified','publicationAllowed','sbomVerified']
  .some((field) => policy[field] === true) || platforms.some((p) => policy.assets?.[p] !== null) || platforms.some((p) => policy.assetSha256?.[p] !== null);
if (!activationRequested) {
  console.log('publication evidence binding remains fail-closed');
  process.exit(0);
}
if (!/^[0-9a-f]{40}$/.test(policy.sourceCommit || '')) throw new Error('publication evidence requires exact sourceCommit');

const subjects = platforms.map((platform) => {
  const asset = policy.assets?.[platform];
  const sha256 = policy.assetSha256?.[platform];
  if (typeof asset !== 'string' || typeof sha256 !== 'string') throw new Error(`missing ${platform} publication subject identity`);
  const name = asset.slice(asset.lastIndexOf('/') + 1);
  if (!name || name.includes('/') || name.includes('\\')) throw new Error(`invalid ${platform} publication subject filename`);
  const sbomEvidence = policy.evidence?.[sbomEvidenceFields[platform]];
  if (typeof sbomEvidence !== 'string') throw new Error(`missing ${platform} SBOM evidence for publication binding`);
  const expectedSbomName = `${name}.sbom.cdx.json`;
  const canonicalSbomPrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/${expectedSbomName}#sha256=`;
  if (!sbomEvidence.startsWith(canonicalSbomPrefix)) throw new Error(`${platform} SBOM evidence must use the canonical immutable release asset path`);
  const sbomMatch = sbomEvidence.match(/\/([^/#]+)#sha256=([0-9a-f]{64})$/);
  if (!sbomMatch || sbomMatch[1] !== expectedSbomName) throw new Error(`${platform} SBOM evidence must use an immutable filename and exact sha256 digest binding`);
  return { platform, artifact: { name, sha256 }, sbom: { name: sbomMatch[1], sha256: sbomMatch[2] } };
});
if (new Set(subjects.map((s) => s.artifact.name)).size !== platforms.length) throw new Error('publication subjects must use distinct artifact filenames');
if (new Set(subjects.map((s) => s.artifact.sha256)).size !== platforms.length) throw new Error('publication subjects must use distinct artifact digests');
if (new Set(subjects.map((s) => s.sbom.name)).size !== platforms.length) throw new Error('publication subjects must use distinct SBOM filenames');
if (new Set(subjects.map((s) => s.sbom.sha256)).size !== platforms.length) throw new Error('publication subjects must use distinct SBOM digests');
const artifactDigests = new Set(subjects.map((s) => s.artifact.sha256));
if (subjects.some((s) => artifactDigests.has(s.sbom.sha256))) throw new Error('publication SBOM digests must not alias promoted artifact digests');

const evidence = policy.evidence?.publication;
if (typeof evidence !== 'string') throw new Error('promotion requires publication evidence');
const evidenceDigest = evidence.match(digestFragment);
if (!evidenceDigest) throw new Error('publication evidence must include exact sha256 digest binding');
const exactUrl = `https://github.com/zyron249/-zyronchain/blob/${policy.sourceCommit}/${evidencePath}`;
if (evidence.slice(0, evidence.length - evidenceDigest[0].length) !== exactUrl) throw new Error('publication evidence must bind canonical exact-sourceCommit Git blob');

const absolutePath = path.resolve(repositoryRoot, evidencePath);
if (!absolutePath.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('publication evidence path escapes repository root');
const stat = lstatSync(absolutePath);
if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('publication evidence must be a regular non-symlink working-tree file');
const workingBytes = readFileSync(absolutePath);
const sourceBytes = exactSourceBlob(evidencePath);
const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
if (sourceDigest !== evidenceDigest[1]) throw new Error('publication digest does not match exact sourceCommit blob bytes');
if (createHash('sha256').update(workingBytes).digest('hex') !== sourceDigest) throw new Error('publication working-tree evidence differs from exact sourceCommit blob');
const otherDigests = new Set(Object.entries(policy.evidence || {})
  .filter(([name]) => name !== 'publication')
  .map(([, value]) => typeof value === 'string' ? value.match(digestFragment)?.[1] : null)
  .filter(Boolean));
if (artifactDigests.has(sourceDigest) || subjects.some((s) => s.sbom.sha256 === sourceDigest) || otherDigests.has(sourceDigest)) throw new Error('publication byte identity must not alias artifact, SBOM, or another evidence role');

let document;
try { document = JSON.parse(sourceBytes.toString('utf8')); } catch { throw new Error('publication evidence must be valid JSON'); }
requireExactKeys(document, ['schemaVersion', 'releaseVersion', 'sourceCommit', 'subjects', 'verification'], 'publication evidence');
if (document.schemaVersion !== 1) throw new Error('publication evidence must use schemaVersion 1');
if (document.releaseVersion !== policy.releaseVersion) throw new Error('publication release identity mismatch');
if (document.sourceCommit !== policy.sourceCommit) throw new Error('publication sourceCommit identity mismatch');
if (!Array.isArray(document.subjects) || JSON.stringify(document.subjects) !== JSON.stringify(subjects)) throw new Error('publication subjects do not match exact promoted artifact/SBOM subjects');
for (const [index, subject] of document.subjects.entries()) {
  requireExactKeys(subject, ['platform', 'artifact', 'sbom'], `publication subject ${index}`);
  requireExactKeys(subject.artifact, ['name', 'sha256'], `publication artifact ${index}`);
  requireExactKeys(subject.sbom, ['name', 'sha256'], `publication SBOM ${index}`);
}
requireExactKeys(document.verification, ['verified', 'method', 'tool'], 'publication verification');
if (document.verification.verified !== true) throw new Error('publication verification must be explicitly true');
if (!allowedMethods.has(document.verification.method)) throw new Error('publication evidence uses an unapproved verification method');
if (typeof document.verification.tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+:/-]{1,127}$/.test(document.verification.tool)) throw new Error('publication evidence requires a bounded verification tool identity');

runGit(['cat-file', '-e', `${policy.sourceCommit}^{commit}`]);
console.log('publication evidence is byte-bound to exact sourceCommit with explicit positive verification');
