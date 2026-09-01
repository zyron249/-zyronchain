#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-checksum-subjects.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const releaseVersion = 'miner-v1.0.0';
const platforms = ['windows', 'macos', 'linux'];

function digestDocument(artifactSubjects, sbomSubjects) {
  const body = `${JSON.stringify({ schemaVersion: 2, releaseVersion, sourceCommit, artifactSubjects, sbomSubjects })}\n`;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function subject(platform, name, sha256) { return { platform, name, sha256 }; }
const artifactSubjects = [
  subject('windows', 'ZyronMiner-windows-x64.zip', '1'.repeat(64)),
  subject('macos', 'ZyronMiner-macos-arm64.tar.gz', '2'.repeat(64)),
  subject('linux', 'ZyronMiner-linux-x64.tar.gz', '3'.repeat(64))
];
const sbomSubjects = [
  subject('windows', `${artifactSubjects[0].name}.sbom.cdx.json`, 'a'.repeat(64)),
  subject('macos', `${artifactSubjects[1].name}.sbom.cdx.json`, 'b'.repeat(64)),
  subject('linux', `${artifactSubjects[2].name}.sbom.cdx.json`, 'c'.repeat(64))
];
const checksumDigest = digestDocument(artifactSubjects, sbomSubjects);
const evidenceDigests = {
  windowsSigning: '4'.repeat(64),
  macosSigningOrNotarization: '5'.repeat(64),
  linuxSigning: 'd'.repeat(64),
  provenance: '6'.repeat(64),
  immutableRelease: '8'.repeat(64),
  publicMiningActivation: '9'.repeat(64)
};
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
  immutableReleaseVerified: true,
  publicationAllowed: true,
  sbomVerified: true,
  assets: Object.fromEntries(artifactSubjects.map((entry) => [entry.platform, `${releasePrefix}${entry.name}`])),
  assetSha256: Object.fromEntries(artifactSubjects.map((entry) => [entry.platform, entry.sha256])),
  evidence: {
    ...base.evidence,
    windowsSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/windows-signing.json#sha256=${evidenceDigests.windowsSigning}`,
    macosSigningOrNotarization: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/macos-notarization.json#sha256=${evidenceDigests.macosSigningOrNotarization}`,
    linuxSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/linux-signing.json#sha256=${evidenceDigests.linuxSigning}`,
    provenance: `${releasePrefix}provenance.json#sha256=${evidenceDigests.provenance}`,
    checksums: `${releasePrefix}SHA256SUMS#sha256=${checksumDigest}`,
    windowsSbom: `${releasePrefix}${sbomSubjects[0].name}#sha256=${sbomSubjects[0].sha256}`,
    macosSbom: `${releasePrefix}${sbomSubjects[1].name}#sha256=${sbomSubjects[1].sha256}`,
    linuxSbom: `${releasePrefix}${sbomSubjects[2].name}#sha256=${sbomSubjects[2].sha256}`,
    immutableRelease: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/immutable-release.json#sha256=${evidenceDigests.immutableRelease}`,
    publicMiningActivation: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/public-mining-activation.json#sha256=${evidenceDigests.publicMiningActivation}`
  }
};

function withChecksumDigest(policy, digest) {
  return { ...policy, evidence: { ...policy.evidence, checksums: policy.evidence.checksums.replace(/[0-9a-f]{64}$/, digest) } };
}
function run(policy, shouldPass, label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zyron-checksum-subjects-'));
  const file = path.join(dir, 'policy.json');
  writeFileSync(file, JSON.stringify(policy, null, 2));
  const result = spawnSync(process.execPath, [verifier, file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr || result.stdout}`);
  if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}

run(base, true, 'inactive canonical policy');
run(active, true, 'exact three-platform artifact and SBOM checksum subject binding');
run(withChecksumDigest(active, digestDocument(artifactSubjects.slice(0, 2), sbomSubjects)), false, 'missing Linux artifact checksum subject');
run(withChecksumDigest(active, digestDocument(artifactSubjects, sbomSubjects.slice(0, 2))), false, 'missing Linux SBOM checksum subject');
run(withChecksumDigest(active, digestDocument([artifactSubjects[0], artifactSubjects[1], artifactSubjects[0]], sbomSubjects)), false, 'duplicate artifact checksum subject');
run(withChecksumDigest(active, digestDocument(artifactSubjects, [sbomSubjects[0], sbomSubjects[1], sbomSubjects[0]])), false, 'duplicate SBOM checksum subject');
run(withChecksumDigest(active, digestDocument([
  { ...artifactSubjects[0], sha256: artifactSubjects[2].sha256 }, artifactSubjects[1], { ...artifactSubjects[2], sha256: artifactSubjects[0].sha256 }
], sbomSubjects)), false, 'swapped cross-platform artifact checksum digests');
run(withChecksumDigest(active, digestDocument(artifactSubjects, [
  { ...sbomSubjects[0], sha256: sbomSubjects[2].sha256 }, sbomSubjects[1], { ...sbomSubjects[2], sha256: sbomSubjects[0].sha256 }
])), false, 'swapped cross-platform SBOM checksum digests');
run(withChecksumDigest(active, digestDocument([
  { ...artifactSubjects[0], name: artifactSubjects[2].name }, artifactSubjects[1], { ...artifactSubjects[2], name: artifactSubjects[0].name }
], sbomSubjects)), false, 'cross-platform artifact checksum filenames');
run(withChecksumDigest(active, digestDocument(artifactSubjects, [
  { ...sbomSubjects[0], name: sbomSubjects[2].name }, sbomSubjects[1], { ...sbomSubjects[2], name: sbomSubjects[0].name }
])), false, 'cross-platform SBOM checksum filenames');
run({ ...active, evidence: { ...active.evidence, checksums: `https://github.com/zyron249/-zyronchain/blob/main/SHA256SUMS#sha256=${checksumDigest}` } }, false, 'mutable checksum reference');
run({ ...active, evidence: { ...active.evidence, checksums: `${releasePrefix}SHA256SUMS` } }, false, 'checksum reference without digest');
run({ ...active, evidence: { ...active.evidence, windowsSbom: `https://github.com/zyron249/-zyronchain/blob/main/${sbomSubjects[0].name}#sha256=${sbomSubjects[0].sha256}` } }, false, 'mutable SBOM checksum subject');
run({ ...active, evidence: { ...active.evidence, macosSbom: `${releasePrefix}${sbomSubjects[1].name}` } }, false, 'SBOM checksum subject without digest');
run({ ...active, evidence: { ...active.evidence, linuxSbom: `${releasePrefix}${sbomSubjects[0].name}#sha256=${sbomSubjects[2].sha256}` } }, false, 'cross-platform SBOM checksum filename substitution');
run({ ...active, evidence: { ...active.evidence, linuxSbom: `${releasePrefix}${sbomSubjects[2].name}#sha256=${sbomSubjects[0].sha256}` } }, false, 'duplicate SBOM checksum digest identity');
run({ ...active, evidence: { ...active.evidence, windowsSbom: `${releasePrefix}${sbomSubjects[0].name}#sha256=${artifactSubjects[0].sha256}` } }, false, 'artifact and SBOM checksum digest alias');
run({ ...active, assetSha256: { ...active.assetSha256, windows: 'd'.repeat(64) } }, false, 'policy artifact checksum subject digest drift');
run({ ...active, assets: { ...active.assets, linux: `${releasePrefix}ZyronMiner-linux-renamed.tar.gz` } }, false, 'policy artifact checksum subject filename drift');
run({ ...base, checksumsVerified: true }, false, 'partial activation state');

if (platforms.length !== artifactSubjects.length || platforms.length !== sbomSubjects.length) throw new Error('test fixture platform cardinality drift');
console.log('miner release checksum artifact and SBOM subject regressions: OK');
