#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyFile = process.argv[2] || path.resolve(process.cwd(), '../docs/miner-release-promotion.json');
const evidenceRoot = path.resolve(process.argv[3] || path.resolve(here, '../..'));
const baselineVerifier = path.join(here, 'verify-miner-release-promotion.mjs');
const baseline = spawnSync(process.execPath, [baselineVerifier, policyFile], { encoding: 'utf8' });
if (baseline.status !== 0) {
  process.stderr.write(baseline.stderr || baseline.stdout || 'baseline miner release promotion verification failed\n');
  process.exit(baseline.status ?? 1);
}

const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
const activationRequested = [
  'publicMiningActivated', 'releaseEligible', 'platformSigningVerified', 'provenanceVerified',
  'checksumsVerified', 'sbomVerified', 'immutableReleaseVerified', 'publicationAllowed'
].some((field) => policy[field] === true) || ['windows', 'macos', 'linux'].some((platform) => policy.assets?.[platform] !== null || policy.assetSha256?.[platform] !== null);

if (!activationRequested) {
  console.log('miner release signing evidence remains fail-closed');
  process.exit(0);
}

const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/`;
const exactBlobPrefix = `https://github.com/zyron249/-zyronchain/blob/${policy.sourceCommit}/`;
const allowedVerification = Object.freeze({
  windows: new Set(['authenticode']),
  macos: new Set(['codesign', 'notarization']),
  linux: new Set(['detached-signature'])
});

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.join(',') !== expected.join(',')) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function evidenceDigest(field, expectedName) {
  const reference = policy.evidence?.[field];
  if (typeof reference !== 'string') throw new Error(`promotion requires ${field} evidence`);
  const match = reference.match(/#sha256=([0-9a-f]{64})$/);
  if (!match) throw new Error(`${field} evidence must include exact sha256 digest binding`);
  const assetReference = reference.slice(0, reference.indexOf('#sha256='));
  if (assetReference !== `${releasePrefix}${expectedName}`) throw new Error(`${field} evidence must use the exact immutable promoted release asset path`);
  return match[1];
}

function canonicalSubject(platform, sbomField) {
  const asset = policy.assets?.[platform];
  const sha256 = policy.assetSha256?.[platform];
  if (typeof asset !== 'string' || typeof sha256 !== 'string') throw new Error(`missing ${platform} signing subject identity`);
  if (!asset.startsWith(releasePrefix)) throw new Error(`invalid ${platform} promoted asset reference`);
  const name = asset.slice(releasePrefix.length);
  if (!name || name.includes('/') || name.includes('\\')) throw new Error(`invalid ${platform} signing subject filename`);
  const sbomName = `${name}.sbom.cdx.json`;
  const sbomSha256 = evidenceDigest(sbomField, sbomName);
  if (sha256 === sbomSha256) throw new Error(`${platform} artifact and SBOM identities must not alias`);
  return { platform, name, sha256, sbom: { name: sbomName, sha256: sbomSha256 } };
}

function readSigningEvidence(field, platform, expectedSubject) {
  const reference = policy.evidence?.[field];
  if (typeof reference !== 'string') throw new Error(`promotion requires ${field} evidence`);
  const match = reference.match(/#sha256=([0-9a-f]{64})$/);
  if (!match) throw new Error(`${field} evidence must include exact sha256 digest binding`);
  const url = reference.slice(0, reference.indexOf('#sha256='));
  if (!url.startsWith(exactBlobPrefix)) throw new Error(`${field} evidence must bind to exact sourceCommit`);
  const relativePath = url.slice(exactBlobPrefix.length);
  const allowedPath = platform === 'windows'
    ? /^evidence\/windows-(?:signing|signature)\.json$/
    : platform === 'macos'
      ? /^evidence\/macos-(?:signing|notarization)\.json$/
      : /^evidence\/linux-(?:signing|signature)\.json$/;
  if (!allowedPath.test(relativePath)) throw new Error(`${field} evidence must use its canonical platform path`);

  const absolutePath = path.resolve(evidenceRoot, relativePath);
  const rootPrefix = `${evidenceRoot}${path.sep}`;
  if (!absolutePath.startsWith(rootPrefix)) throw new Error(`${field} evidence path escapes checked-out source root`);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${field} evidence must be a regular non-symlink file`);
  const bytes = readFileSync(absolutePath);
  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== match[1]) throw new Error(`${field} evidence digest does not match checked-out evidence bytes`);

  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${field} evidence must be valid JSON`);
  }
  requireExactKeys(document, ['schemaVersion', 'releaseVersion', 'sourceCommit', 'subject', 'verification'], `${field} evidence`);
  if (document.schemaVersion !== 3) throw new Error(`${field} evidence must use signing schemaVersion 3`);
  if (document.releaseVersion !== policy.releaseVersion || document.sourceCommit !== policy.sourceCommit) {
    throw new Error(`${field} evidence release/source identity mismatch`);
  }
  requireExactKeys(document.subject, ['platform', 'name', 'sha256', 'sbom'], `${field} subject`);
  requireExactKeys(document.subject.sbom, ['name', 'sha256'], `${field} SBOM subject`);
  if (JSON.stringify(document.subject) !== JSON.stringify(expectedSubject)) {
    throw new Error(`${field} evidence is not bound to the exact promoted artifact and SBOM subjects`);
  }
  requireExactKeys(document.verification, ['verified', 'method', 'tool'], `${field} verification`);
  if (document.verification.verified !== true) throw new Error(`${field} evidence verification must be explicitly true`);
  if (!allowedVerification[platform].has(document.verification.method)) {
    throw new Error(`${field} evidence uses an unapproved ${platform} verification method`);
  }
  if (typeof document.verification.tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+:/-]{1,127}$/.test(document.verification.tool)) {
    throw new Error(`${field} evidence requires a bounded verification tool identity`);
  }
}

const bindings = [
  ['windows', 'windowsSigning', 'windowsSbom'],
  ['macos', 'macosSigningOrNotarization', 'macosSbom'],
  ['linux', 'linuxSigning', 'linuxSbom']
];
for (const [platform, evidenceName, sbomField] of bindings) {
  readSigningEvidence(evidenceName, platform, canonicalSubject(platform, sbomField));
}

console.log('miner release signing evidence bytes and verified platform subjects are bound to exact promoted Windows, macOS and Linux artifact/SBOM identities');
