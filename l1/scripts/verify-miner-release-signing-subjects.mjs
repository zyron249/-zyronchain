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
const activationRequested = [
  'publicMiningActivated', 'releaseEligible', 'platformSigningVerified', 'provenanceVerified',
  'checksumsVerified', 'sbomVerified', 'immutableReleaseVerified', 'publicationAllowed'
].some((field) => policy[field] === true) || ['windows', 'macos', 'linux'].some((platform) => policy.assets?.[platform] !== null || policy.assetSha256?.[platform] !== null);

if (!activationRequested) {
  console.log('miner release signing subject binding remains fail-closed');
  process.exit(0);
}

const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/`;
function evidenceDigest(field, expectedName) {
  const reference = policy.evidence?.[field];
  if (typeof reference !== 'string') throw new Error(`promotion requires ${field} evidence`);
  const match = reference.match(/#sha256=([0-9a-f]{64})$/);
  if (!match) throw new Error(`${field} evidence must include exact sha256 digest binding`);
  const assetReference = reference.slice(0, reference.indexOf('#sha256='));
  if (assetReference !== `${releasePrefix}${expectedName}`) throw new Error(`${field} evidence must use the exact immutable promoted release asset path`);
  return match[1];
}

function canonicalDigest(platform, sbomField) {
  const asset = policy.assets?.[platform];
  const sha256 = policy.assetSha256?.[platform];
  if (typeof asset !== 'string' || typeof sha256 !== 'string') throw new Error(`missing ${platform} signing subject identity`);
  if (!asset.startsWith(releasePrefix)) throw new Error(`invalid ${platform} promoted asset reference`);
  const name = asset.slice(releasePrefix.length);
  if (!name || name.includes('/') || name.includes('\\')) throw new Error(`invalid ${platform} signing subject filename`);
  const sbomName = `${name}.sbom.cdx.json`;
  const sbomSha256 = evidenceDigest(sbomField, sbomName);
  if (sha256 === sbomSha256) throw new Error(`${platform} artifact and SBOM identities must not alias`);
  const body = `${JSON.stringify({ schemaVersion: 2, releaseVersion: policy.releaseVersion, sourceCommit: policy.sourceCommit, subject: { platform, name, sha256, sbom: { name: sbomName, sha256: sbomSha256 } } })}\n`;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

const bindings = [
  ['windows', 'windowsSigning', 'windowsSbom'],
  ['macos', 'macosSigningOrNotarization', 'macosSbom'],
  ['linux', 'linuxSigning', 'linuxSbom']
];
for (const [platform, evidenceName, sbomField] of bindings) {
  const reference = policy.evidence?.[evidenceName];
  if (typeof reference !== 'string') throw new Error(`promotion requires ${evidenceName} evidence`);
  const match = reference.match(/#sha256=([0-9a-f]{64})$/);
  if (!match) throw new Error(`${evidenceName} evidence must include exact sha256 digest binding`);
  const expected = canonicalDigest(platform, sbomField);
  if (match[1] !== expected) throw new Error(`${evidenceName} evidence is not bound to the exact promoted ${platform} artifact and SBOM subjects`);
}

console.log('miner release signing evidence is bound to exact promoted Windows, macOS and Linux artifact and SBOM subjects');
