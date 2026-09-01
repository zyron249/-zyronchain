#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-provenance-subjects.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const releaseVersion = 'miner-v1.0.0';
const platforms = ['windows', 'macos', 'linux'];

function digestDocument(subjects) {
  const body = `${JSON.stringify({ schemaVersion: 1, releaseVersion, sourceCommit, subjects })}\n`;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function subject(platform, name, sha256) { return { platform, name, sha256 }; }
const subjects = [
  subject('windows', 'ZyronMiner-windows-x64.zip', '1'.repeat(64)),
  subject('macos', 'ZyronMiner-macos-arm64.tar.gz', '2'.repeat(64)),
  subject('linux', 'ZyronMiner-linux-x64.tar.gz', '3'.repeat(64))
];
const provenanceDigest = digestDocument(subjects);
const evidenceDigests = {
  windowsSigning: '4'.repeat(64),
  macosSigningOrNotarization: '5'.repeat(64),
  checksums: '7'.repeat(64),
  immutableRelease: '8'.repeat(64),
  publicMiningActivation: '9'.repeat(64)
};
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
  assets: Object.fromEntries(subjects.map((entry) => [entry.platform, `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/${entry.name}`])),
  assetSha256: Object.fromEntries(subjects.map((entry) => [entry.platform, entry.sha256])),
  evidence: {
    ...base.evidence,
    windowsSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/windows-signing.json#sha256=${evidenceDigests.windowsSigning}`,
    macosSigningOrNotarization: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/macos-notarization.json#sha256=${evidenceDigests.macosSigningOrNotarization}`,
    provenance: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/provenance.json#sha256=${provenanceDigest}`,
    checksums: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/SHA256SUMS#sha256=${evidenceDigests.checksums}`,
    immutableRelease: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/immutable-release.json#sha256=${evidenceDigests.immutableRelease}`,
    publicMiningActivation: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/public-mining-activation.json#sha256=${evidenceDigests.publicMiningActivation}`
  }
};

function withProvenanceDigest(policy, digest) {
  return { ...policy, evidence: { ...policy.evidence, provenance: policy.evidence.provenance.replace(/[0-9a-f]{64}$/, digest) } };
}
function run(policy, shouldPass, label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zyron-provenance-subjects-'));
  const file = path.join(dir, 'policy.json');
  writeFileSync(file, JSON.stringify(policy, null, 2));
  const result = spawnSync(process.execPath, [verifier, file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr || result.stdout}`);
  if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}

run(base, true, 'inactive canonical policy');
run(active, true, 'exact three-platform provenance subject binding');
run(withProvenanceDigest(active, digestDocument(subjects.slice(0, 2))), false, 'missing Linux provenance subject');
run(withProvenanceDigest(active, digestDocument([subjects[0], subjects[1], subjects[0]])), false, 'duplicate provenance subject');
run(withProvenanceDigest(active, digestDocument([
  { ...subjects[0], sha256: subjects[2].sha256 }, subjects[1], { ...subjects[2], sha256: subjects[0].sha256 }
])), false, 'swapped cross-platform provenance digests');
run(withProvenanceDigest(active, digestDocument([
  { ...subjects[0], name: subjects[2].name }, subjects[1], { ...subjects[2], name: subjects[0].name }
])), false, 'cross-platform provenance filenames');
run({ ...active, evidence: { ...active.evidence, provenance: `https://github.com/zyron249/-zyronchain/blob/main/evidence/provenance.json#sha256=${provenanceDigest}` } }, false, 'mutable provenance reference');
run({ ...active, evidence: { ...active.evidence, provenance: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/provenance.json` } }, false, 'provenance reference without digest');
run({ ...active, assetSha256: { ...active.assetSha256, windows: active.assetSha256.linux } }, false, 'policy subject digest drift');

if (platforms.length !== subjects.length) throw new Error('test fixture platform cardinality drift');
console.log('miner release provenance subject regressions: OK');
