#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.resolve(process.cwd(), '../docs/miner-release-promotion.json');
const repositoryRoot = path.resolve(process.argv[3] || path.resolve(here, '../..'));
const policy = JSON.parse(readFileSync(file, 'utf8'));
const platforms = ['windows', 'macos', 'linux'];
const sbomKeys = { windows: 'windowsSbom', macos: 'macosSbom', linux: 'linuxSbom' };
const evidencePath = 'evidence/sbom-verification.json';
const allowedMethods = new Set(['cyclonedx-sbom-verification', 'release-sbom-verification']);

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.join(',') !== expected.join(',')) throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
}
function runGit(args, binary = false) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], { encoding: binary ? undefined : 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`unable to resolve SBOM verification evidence from exact source commit: ${(binary ? result.stderr?.toString('utf8') : result.stderr) || args.join(' ')}`);
  return result.stdout;
}
function exactSourceBlob(relativePath) {
  const line = runGit(['ls-tree', policy.sourceCommit, '--', relativePath]).trimEnd();
  const match = line.match(/^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/);
  if (!match || match[3] !== relativePath) throw new Error('SBOM verification evidence must be a regular file in exact sourceCommit');
  const bytes = runGit(['show', `${policy.sourceCommit}:${relativePath}`], true);
  if (!Buffer.isBuffer(bytes)) throw new Error('SBOM verification exact source blob unavailable');
  return bytes;
}

if (policy.schemaVersion !== 4) throw new Error('SBOM promotion gate requires schemaVersion=4');
if (typeof policy.sbomVerified !== 'boolean') throw new Error('sbomVerified must be boolean');
if (!policy.evidence || typeof policy.evidence !== 'object' || Array.isArray(policy.evidence)) throw new Error('evidence object required');
for (const key of [...Object.values(sbomKeys), 'sbomVerification']) {
  if (!(key in policy.evidence)) throw new Error(`missing ${key} evidence slot`);
}

const anyActivation = policy.publicMiningActivated === true || policy.releaseEligible === true || policy.publicationAllowed === true ||
  Object.values(policy.assets || {}).some((value) => value !== null) || Object.values(policy.assetSha256 || {}).some((value) => value !== null);
if (!anyActivation) {
  if (policy.sbomVerified !== false) throw new Error('inactive promotion must keep sbomVerified=false');
  for (const key of [...Object.values(sbomKeys), 'sbomVerification']) {
    if (policy.evidence[key] !== null) throw new Error(`inactive promotion must not carry ${key} evidence`);
  }
  console.log('miner release SBOM evidence remains fail-closed');
  process.exit(0);
}

if (policy.sbomVerified !== true) throw new Error('promotion requires sbomVerified=true');
if (!/^[0-9a-f]{40}$/.test(policy.sourceCommit || '')) throw new Error('SBOM evidence requires exact sourceCommit');
if (!/^miner-v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(policy.releaseVersion || '')) throw new Error('SBOM evidence requires canonical releaseVersion');

const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/`;
const digestFragment = /#sha256=([0-9a-f]{64})$/;
const refs = new Set();
const digests = new Set();
const subjects = [];
const assetDigests = new Set(platforms.map((platform) => policy.assetSha256?.[platform]).filter((value) => typeof value === 'string'));
const coreEvidenceDigests = new Set(Object.entries(policy.evidence)
  .filter(([name]) => !Object.values(sbomKeys).includes(name) && name !== 'sbomVerification')
  .map(([, value]) => typeof value === 'string' ? value.match(digestFragment)?.[1] : null)
  .filter(Boolean));

for (const platform of platforms) {
  const asset = policy.assets?.[platform];
  const assetDigest = policy.assetSha256?.[platform];
  if (typeof asset !== 'string' || !asset.startsWith(releasePrefix)) throw new Error(`${platform} SBOM evidence requires canonical promoted asset`);
  if (typeof assetDigest !== 'string' || !/^[0-9a-f]{64}$/.test(assetDigest)) throw new Error(`${platform} SBOM evidence requires promoted artifact digest`);
  const assetName = asset.slice(releasePrefix.length);
  const expectedSbomName = `${assetName}.sbom.cdx.json`;
  const value = policy.evidence[sbomKeys[platform]];
  if (typeof value !== 'string') throw new Error(`promotion requires ${platform} SBOM evidence`);
  const match = value.match(digestFragment);
  if (!match) throw new Error(`${platform} SBOM evidence must include exact sha256 digest binding`);
  const reference = value.slice(0, value.length - match[0].length);
  if (reference !== `${releasePrefix}${expectedSbomName}`) throw new Error(`${platform} SBOM evidence must use exact promoted-artifact SBOM asset name`);
  if (refs.has(reference)) throw new Error('SBOM evidence references must be distinct per platform');
  if (digests.has(match[1])) throw new Error('SBOM evidence sha256 identities must be distinct per platform');
  if (assetDigests.has(match[1])) throw new Error(`${platform} SBOM evidence must not alias promoted artifact bytes`);
  if (coreEvidenceDigests.has(match[1])) throw new Error(`${platform} SBOM evidence must not alias another evidence role`);
  refs.add(reference);
  digests.add(match[1]);
  subjects.push({ platform, artifact: { name: assetName, sha256: assetDigest }, sbom: { name: expectedSbomName, sha256: match[1] } });
}

const verificationRef = policy.evidence.sbomVerification;
if (typeof verificationRef !== 'string') throw new Error('promotion requires sbomVerification evidence');
const verificationDigest = verificationRef.match(digestFragment);
if (!verificationDigest) throw new Error('sbomVerification evidence must include exact sha256 digest binding');
const exactUrl = `https://github.com/zyron249/-zyronchain/blob/${policy.sourceCommit}/${evidencePath}`;
if (verificationRef.slice(0, verificationRef.length - verificationDigest[0].length) !== exactUrl) throw new Error('sbomVerification evidence must bind canonical exact-sourceCommit Git blob');

const absolutePath = path.resolve(repositoryRoot, evidencePath);
if (!absolutePath.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('sbomVerification evidence path escapes repository root');
const stat = lstatSync(absolutePath);
if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('sbomVerification evidence must be a regular non-symlink working-tree file');
const workingBytes = readFileSync(absolutePath);
const sourceBytes = exactSourceBlob(evidencePath);
const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
if (sourceDigest !== verificationDigest[1]) throw new Error('sbomVerification digest does not match exact sourceCommit blob bytes');
if (createHash('sha256').update(workingBytes).digest('hex') !== sourceDigest) throw new Error('sbomVerification working-tree evidence differs from exact sourceCommit blob');
if (assetDigests.has(sourceDigest) || digests.has(sourceDigest) || coreEvidenceDigests.has(sourceDigest)) throw new Error('sbomVerification byte identity must not alias artifact, SBOM, or another evidence role');

let document;
try { document = JSON.parse(sourceBytes.toString('utf8')); } catch { throw new Error('sbomVerification evidence must be valid JSON'); }
requireExactKeys(document, ['schemaVersion', 'releaseVersion', 'subjects', 'verification'], 'sbomVerification evidence');
if (document.schemaVersion !== 1) throw new Error('sbomVerification evidence must use schemaVersion 1');
if (document.releaseVersion !== policy.releaseVersion) throw new Error('sbomVerification release identity mismatch');
if (!Array.isArray(document.subjects) || JSON.stringify(document.subjects) !== JSON.stringify(subjects)) throw new Error('sbomVerification subjects do not match exact promoted artifact/SBOM subjects');
for (const [index, subject] of document.subjects.entries()) {
  requireExactKeys(subject, ['platform', 'artifact', 'sbom'], `sbomVerification subject ${index}`);
  requireExactKeys(subject.artifact, ['name', 'sha256'], `sbomVerification artifact ${index}`);
  requireExactKeys(subject.sbom, ['name', 'sha256'], `sbomVerification SBOM ${index}`);
}
requireExactKeys(document.verification, ['verified', 'method', 'tool'], 'sbomVerification verification');
if (document.verification.verified !== true) throw new Error('sbomVerification verification must be explicitly true');
if (!allowedMethods.has(document.verification.method)) throw new Error('sbomVerification evidence uses an unapproved verification method');
if (typeof document.verification.tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+:/-]{1,127}$/.test(document.verification.tool)) throw new Error('sbomVerification evidence requires a bounded verification tool identity');

runGit(['cat-file', '-e', `${policy.sourceCommit}^{commit}`]);
console.log('miner release SBOM evidence is byte-bound to exact sourceCommit with explicit positive verification');
