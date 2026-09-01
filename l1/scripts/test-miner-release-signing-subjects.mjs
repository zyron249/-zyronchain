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
const sbomDigests = { windows: 'a'.repeat(64), macos: 'b'.repeat(64), linux: 'c'.repeat(64) };

function signingDigest(platform, name = assets[platform], sha256 = digests[platform], sbomName = `${name}.sbom.cdx.json`, sbomSha256 = sbomDigests[platform]) {
  const body = `${JSON.stringify({ schemaVersion: 2, releaseVersion, sourceCommit, subject: { platform, name, sha256, sbom: { name: sbomName, sha256: sbomSha256 } } })}\n`;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
const windowsSigning = signingDigest('windows');
const macosSigning = signingDigest('macos');
const linuxSigning = signingDigest('linux');
const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/`;
const active = {
  ...base,
  releaseVersion,
  sourceCommit,
  publicMiningActivated: true,
  releaseEligible: true,
  platformSigningVerified: true,
  provenanceVerified: true,
  checksumsVerified: true,
  sbomVerified: true,
  immutableReleaseVerified: true,
  publicationAllowed: true,
  assets: Object.fromEntries(Object.entries(assets).map(([platform, name]) => [platform, `${releasePrefix}${name}`])),
  assetSha256: digests,
  evidence: {
    ...base.evidence,
    windowsSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/windows-signing.json#sha256=${windowsSigning}`,
    macosSigningOrNotarization: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/macos-notarization.json#sha256=${macosSigning}`,
    linuxSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/linux-signing.json#sha256=${linuxSigning}`,
    provenance: `${releasePrefix}provenance.json#sha256=${'6'.repeat(64)}`,
    checksums: `${releasePrefix}SHA256SUMS#sha256=${'7'.repeat(64)}`,
    windowsSbom: `${releasePrefix}${assets.windows}.sbom.cdx.json#sha256=${sbomDigests.windows}`,
    macosSbom: `${releasePrefix}${assets.macos}.sbom.cdx.json#sha256=${sbomDigests.macos}`,
    linuxSbom: `${releasePrefix}${assets.linux}.sbom.cdx.json#sha256=${sbomDigests.linux}`,
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
run(active, true, 'exact Windows, macOS and Linux artifact plus SBOM signing subject binding');
run(withEvidenceDigest(active, 'windowsSigning', signingDigest('windows', assets.linux, digests.windows, `${assets.windows}.sbom.cdx.json`, sbomDigests.windows)), false, 'Windows signing filename drift');
run(withEvidenceDigest(active, 'macosSigningOrNotarization', signingDigest('macos', assets.windows, digests.macos, `${assets.macos}.sbom.cdx.json`, sbomDigests.macos)), false, 'macOS signing filename drift');
run(withEvidenceDigest(active, 'linuxSigning', signingDigest('linux', assets.windows, digests.linux, `${assets.linux}.sbom.cdx.json`, sbomDigests.linux)), false, 'Linux signing filename drift');
run(withEvidenceDigest(active, 'linuxSigning', signingDigest('linux', assets.linux, digests.windows, `${assets.linux}.sbom.cdx.json`, sbomDigests.linux)), false, 'Linux signing digest drift');
run(withEvidenceDigest(active, 'linuxSigning', signingDigest('linux', assets.linux, digests.linux, `${assets.linux}.sbom.cdx.json`, sbomDigests.windows)), false, 'Linux signing SBOM digest drift');
run(withEvidenceDigest(active, 'linuxSigning', signingDigest('windows', assets.windows, digests.windows, `${assets.windows}.sbom.cdx.json`, sbomDigests.windows)), false, 'cross-platform Linux signing evidence');
run({ ...active, evidence: { ...active.evidence, linuxSigning: null } }, false, 'missing Linux signing evidence');
run({ ...active, evidence: { ...active.evidence, linuxSigning: active.evidence.linuxSigning.replace(`/blob/${sourceCommit}/`, '/blob/main/') } }, false, 'mutable Linux signing reference');
run({ ...active, evidence: { ...active.evidence, linuxSigning: active.evidence.linuxSigning.replace('/evidence/linux-signing.json', '/evidence/operator-linux-signing.json') } }, false, 'non-canonical Linux signing path');
run({ ...active, evidence: { ...active.evidence, linuxSigning: active.evidence.linuxSigning.replace(/#sha256=.*/, '') } }, false, 'Linux signing evidence without digest');
run({ ...active, evidence: { ...active.evidence, linuxSbom: active.evidence.linuxSbom.replace(releasePrefix, 'https://github.com/zyron249/-zyronchain/releases/latest/download/') } }, false, 'mutable Linux SBOM reference');
run({ ...active, assetSha256: { ...active.assetSha256, linux: sbomDigests.linux } }, false, 'Linux artifact and SBOM digest alias');

console.log('miner release Windows/macOS/Linux signing artifact and SBOM subject regressions: OK');
