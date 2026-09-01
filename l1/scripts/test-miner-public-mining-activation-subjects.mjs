#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-public-mining-activation-subjects.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const releaseVersion = 'miner-v1.0.0';
const subjects = [
  { platform: 'windows', name: 'ZyronMiner-windows-x64.zip', sha256: '1'.repeat(64), sbom: { name: 'ZyronMiner-windows-x64.zip.sbom.cdx.json', sha256: 'a'.repeat(64) } },
  { platform: 'macos', name: 'ZyronMiner-macos-arm64.tar.gz', sha256: '2'.repeat(64), sbom: { name: 'ZyronMiner-macos-arm64.tar.gz.sbom.cdx.json', sha256: 'b'.repeat(64) } },
  { platform: 'linux', name: 'ZyronMiner-linux-x64.tar.gz', sha256: '3'.repeat(64), sbom: { name: 'ZyronMiner-linux-x64.tar.gz.sbom.cdx.json', sha256: 'c'.repeat(64) } }
];
const digestDocument = (items, version = releaseVersion, commit = sourceCommit) => createHash('sha256').update(`${JSON.stringify({ schemaVersion: 2, releaseVersion: version, sourceCommit: commit, subjects: items })}\n`).digest('hex');
const activationDigest = digestDocument(subjects);
const active = {
  ...base, releaseVersion, sourceCommit,
  publicMiningActivated: true, releaseEligible: true, platformSigningVerified: true, provenanceVerified: true,
  checksumsVerified: true, immutableReleaseVerified: true, publicationAllowed: true, sbomVerified: true,
  assets: Object.fromEntries(subjects.map((s) => [s.platform, `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/${s.name}`])),
  assetSha256: Object.fromEntries(subjects.map((s) => [s.platform, s.sha256])),
  evidence: {
    windowsSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/windows-signing.json#sha256=${'4'.repeat(64)}`,
    macosSigningOrNotarization: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/macos-notarization.json#sha256=${'5'.repeat(64)}`,
    linuxSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/linux-signing.json#sha256=${'9'.repeat(64)}`,
    provenance: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/provenance.json#sha256=${'6'.repeat(64)}`,
    checksums: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/SHA256SUMS#sha256=${'7'.repeat(64)}`,
    windowsSbom: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/${subjects[0].sbom.name}#sha256=${subjects[0].sbom.sha256}`,
    macosSbom: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/${subjects[1].sbom.name}#sha256=${subjects[1].sbom.sha256}`,
    linuxSbom: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/${subjects[2].sbom.name}#sha256=${subjects[2].sbom.sha256}`,
    immutableRelease: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/immutable-release.json#sha256=${'8'.repeat(64)}`,
    publicMiningActivation: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/public-mining-activation.json#sha256=${activationDigest}`
  }
};
function run(policy, shouldPass, label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zyron-public-mining-subjects-'));
  const file = path.join(dir, 'policy.json'); writeFileSync(file, JSON.stringify(policy, null, 2));
  const result = spawnSync(process.execPath, [verifier, file], { encoding: 'utf8' }); rmSync(dir, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr || result.stdout}`);
  if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}
const withDigest = (digest) => ({ ...active, evidence: { ...active.evidence, publicMiningActivation: active.evidence.publicMiningActivation.replace(/[0-9a-f]{64}$/, digest) } });
run(base, true, 'inactive canonical policy');
run(active, true, 'exact public mining activation artifact and SBOM binding');
run(withDigest(digestDocument(subjects.slice(0, 2))), false, 'missing platform subject');
run(withDigest(digestDocument([subjects[0], subjects[1], subjects[0]])), false, 'duplicate subject');
run(withDigest(digestDocument([{...subjects[0], sha256: subjects[2].sha256}, subjects[1], {...subjects[2], sha256: subjects[0].sha256}])), false, 'cross-platform artifact digest swap');
run(withDigest(digestDocument([{...subjects[0], name: subjects[2].name}, subjects[1], {...subjects[2], name: subjects[0].name}])), false, 'cross-platform artifact filename swap');
run(withDigest(digestDocument([{...subjects[0], sbom: subjects[2].sbom}, subjects[1], {...subjects[2], sbom: subjects[0].sbom}])), false, 'cross-platform SBOM swap');
run(withDigest(digestDocument([{...subjects[0], sbom: {...subjects[0].sbom, sha256: 'd'.repeat(64)}}, subjects[1], subjects[2]])), false, 'SBOM digest drift');
run(withDigest(digestDocument([{...subjects[0], sbom: {...subjects[0].sbom, name: 'other.sbom.cdx.json'}}, subjects[1], subjects[2]])), false, 'SBOM filename drift');
run(withDigest(digestDocument(subjects, 'miner-v1.0.1')), false, 'release version drift');
run(withDigest(digestDocument(subjects, releaseVersion, 'fedcba9876543210fedcba9876543210fedcba98')), false, 'source commit drift');
run({ ...active, evidence: { ...active.evidence, windowsSbom: active.evidence.windowsSbom.replace(/#sha256=.*/, '') } }, false, 'digestless SBOM evidence');
run({ ...active, evidence: { ...active.evidence, windowsSbom: active.evidence.windowsSbom.replace(`/releases/download/${releaseVersion}/`, '/blob/main/') } }, false, 'mutable SBOM evidence');
run({ ...active, evidence: { ...active.evidence, windowsSbom: active.evidence.windowsSbom.replace(subjects[0].sbom.sha256, subjects[0].sha256) } }, false, 'artifact SBOM digest alias');
run({ ...active, evidence: { ...active.evidence, publicMiningActivation: `https://github.com/zyron249/-zyronchain/blob/main/evidence/public-mining-activation.json#sha256=${activationDigest}` } }, false, 'mutable activation evidence ref');
run({ ...active, evidence: { ...active.evidence, publicMiningActivation: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/public-mining-activation.json` } }, false, 'digestless activation evidence');
run({ ...active, assetSha256: { ...active.assetSha256, windows: active.assetSha256.linux } }, false, 'policy artifact subject drift');
run({ ...active, evidence: { ...active.evidence, windowsSbom: active.evidence.windowsSbom.replace(subjects[0].sbom.sha256, 'd'.repeat(64)) } }, false, 'policy SBOM subject drift');
console.log('public mining activation artifact + SBOM subject regressions: OK');
