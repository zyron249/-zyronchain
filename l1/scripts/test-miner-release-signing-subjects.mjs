#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-signing-subjects.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const releaseVersion = 'miner-v1.0.0';
const assets = {
  windows: 'ZyronMiner-windows-x64.zip',
  macos: 'ZyronMiner-macos-arm64.tar.gz',
  linux: 'ZyronMiner-linux-x64.tar.gz'
};
const digests = { windows: '1'.repeat(64), macos: '2'.repeat(64), linux: '3'.repeat(64) };

function signingDigest(platform, name = assets[platform], sha256 = digests[platform]) {
  const body = `${JSON.stringify({ schemaVersion: 1, releaseVersion, sourceCommit, subject: { platform, name, sha256 } })}\n`;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
const windowsSigning = signingDigest('windows');
const macosSigning = signingDigest('macos');
const active = {
  ...base,
  releaseVersion,
  sourceCommit,
  publicMiningActivated: true,
  releaseEligible: true,
  platformSigningVerified: true,
  provenanceVerified: true,
  checksumsVerified: true,
  immutableReleaseVerified: true,
  publicationAllowed: true,
  assets: Object.fromEntries(Object.entries(assets).map(([platform, name]) => [platform, `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/${name}`])),
  assetSha256: digests,
  evidence: {
    windowsSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/windows-signing.json#sha256=${windowsSigning}`,
    macosSigningOrNotarization: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/macos-notarization.json#sha256=${macosSigning}`,
    provenance: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/provenance.json#sha256=${'6'.repeat(64)}`,
    checksums: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/SHA256SUMS#sha256=${'7'.repeat(64)}`,
    immutableRelease: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/immutable-release.json#sha256=${'8'.repeat(64)}`,
    publicMiningActivation: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/public-mining-activation.json#sha256=${'9'.repeat(64)}`
  }
};

function withEvidenceDigest(policy, field, digest) {
  return { ...policy, evidence: { ...policy.evidence, [field]: policy.evidence[field].replace(/[0-9a-f]{64}$/, digest) } };
}
function run(policy, shouldPass, label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zyron-signing-subjects-'));
  const file = path.join(dir, 'policy.json');
  writeFileSync(file, JSON.stringify(policy, null, 2));
  const result = spawnSync(process.execPath, [verifier, file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr || result.stdout}`);
  if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}

run(base, true, 'inactive canonical policy');
run(active, true, 'exact Windows and macOS signing subject binding');
run(withEvidenceDigest(active, 'windowsSigning', signingDigest('windows', assets.linux, digests.windows)), false, 'Windows signing filename drift');
run(withEvidenceDigest(active, 'windowsSigning', signingDigest('windows', assets.windows, digests.linux)), false, 'Windows signing digest drift');
run(withEvidenceDigest(active, 'windowsSigning', signingDigest('macos', assets.macos, digests.macos)), false, 'cross-platform Windows signing evidence');
run(withEvidenceDigest(active, 'macosSigningOrNotarization', signingDigest('macos', assets.windows, digests.macos)), false, 'macOS signing filename drift');
run(withEvidenceDigest(active, 'macosSigningOrNotarization', signingDigest('macos', assets.macos, digests.windows)), false, 'macOS signing digest drift');
run({ ...active, evidence: { ...active.evidence, windowsSigning: active.evidence.windowsSigning.replace(`/blob/${sourceCommit}/`, '/blob/main/') } }, false, 'mutable Windows signing reference');
run({ ...active, evidence: { ...active.evidence, macosSigningOrNotarization: active.evidence.macosSigningOrNotarization.replace(/#sha256=.*/, '') } }, false, 'macOS signing evidence without digest');
run({ ...active, assetSha256: { ...active.assetSha256, windows: active.assetSha256.linux } }, false, 'promoted Windows digest drift');

console.log('miner release signing subject regressions: OK');
