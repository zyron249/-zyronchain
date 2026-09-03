#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-immutable-subjects.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const releaseVersion = 'miner-v1.0.0';
const evidencePath = 'evidence/immutable-release.json';
const subjects = [
  { platform: 'windows', name: 'ZyronMiner-windows-x64.zip', sha256: '1'.repeat(64), sbom: { name: 'ZyronMiner-windows-x64.zip.sbom.cdx.json', sha256: 'a'.repeat(64) } },
  { platform: 'macos', name: 'ZyronMiner-macos-arm64.tar.gz', sha256: '2'.repeat(64), sbom: { name: 'ZyronMiner-macos-arm64.tar.gz.sbom.cdx.json', sha256: 'b'.repeat(64) } },
  { platform: 'linux', name: 'ZyronMiner-linux-x64.tar.gz', sha256: '3'.repeat(64), sbom: { name: 'ZyronMiner-linux-x64.tar.gz.sbom.cdx.json', sha256: 'c'.repeat(64) } }
];
const verification = { verified: true, method: 'github-release-immutable', tool: 'gh release verify' };
const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const document = (overrides = {}) => ({ schemaVersion: overrides.schemaVersion ?? 3, releaseVersion: overrides.releaseVersion ?? releaseVersion, subjects: overrides.subjects ?? subjects, verification: overrides.verification ?? verification, ...(overrides.extra ? { extra: true } : {}) });
const serialize = (value) => `${JSON.stringify(value)}\n`;
function git(root, args) { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr || result.stdout); return result.stdout.trim(); }
function commitEvidence(root) { git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Zyron Test']); git(root, ['config', 'user.email', 'zyron-test@example.invalid']); git(root, ['add', 'evidence']); git(root, ['commit', '-q', '-m', 'test immutable evidence']); return git(root, ['rev-parse', 'HEAD']); }
function active(sourceCommit, digest) {
  const exact = `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/`;
  return { ...base, releaseVersion, sourceCommit, publicMiningActivated: true, releaseEligible: true, platformSigningVerified: true, provenanceVerified: true, checksumsVerified: true, sbomVerified: true, immutableReleaseVerified: true, publicationAllowed: true,
    assets: Object.fromEntries(subjects.map((s) => [s.platform, `${releasePrefix}${s.name}`])), assetSha256: Object.fromEntries(subjects.map((s) => [s.platform, s.sha256])),
    evidence: { ...base.evidence,
      windowsSigning: `${exact}evidence/windows-signing.json#sha256=${'4'.repeat(64)}`,
      macosSigningOrNotarization: `${exact}evidence/macos-notarization.json#sha256=${'5'.repeat(64)}`,
      linuxSigning: `${exact}evidence/linux-signing.json#sha256=${'d'.repeat(64)}`,
      provenance: `${exact}evidence/provenance.json#sha256=${'6'.repeat(64)}`,
      checksums: `${releasePrefix}SHA256SUMS#sha256=${'7'.repeat(64)}`,
      windowsSbom: `${releasePrefix}${subjects[0].sbom.name}#sha256=${subjects[0].sbom.sha256}`,
      macosSbom: `${releasePrefix}${subjects[1].sbom.name}#sha256=${subjects[1].sbom.sha256}`,
      linuxSbom: `${releasePrefix}${subjects[2].sbom.name}#sha256=${subjects[2].sbom.sha256}`,
      immutableRelease: `${exact}${evidencePath}#sha256=${digest}`,
      publicMiningActivation: `${exact}evidence/public-mining-activation.json#sha256=${'9'.repeat(64)}` }
  };
}
function run({ label, shouldPass, doc = document(), mutatePolicy, mutateWorkingTree, symlinkEvidence = false }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zyron-immutable-evidence-')); mkdirSync(path.join(root, 'evidence'), { recursive: true });
  const target = path.join(root, evidencePath); const bytes = serialize(doc); writeFileSync(target, bytes);
  if (symlinkEvidence && process.platform !== 'win32') { const real = `${target}.real`; writeFileSync(real, bytes); rmSync(target); symlinkSync(path.basename(real), target); }
  const sourceCommit = commitEvidence(root); let policy = active(sourceCommit, sha256(bytes)); if (mutatePolicy) policy = mutatePolicy(policy, sourceCommit); if (mutateWorkingTree) mutateWorkingTree(root);
  const policyFile = path.join(root, 'policy.json'); writeFileSync(policyFile, JSON.stringify(policy, null, 2));
  const result = spawnSync(process.execPath, [verifier, policyFile, root], { encoding: 'utf8' }); rmSync(root, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr || result.stdout}`); if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'zyron-immutable-inactive-')); const policyFile = path.join(root, 'policy.json'); writeFileSync(policyFile, JSON.stringify(base)); const result = spawnSync(process.execPath, [verifier, policyFile, root], { encoding: 'utf8' }); rmSync(root, { recursive: true, force: true }); if (result.status !== 0) throw new Error('inactive policy should pass');
}
run({ label: 'structured exact immutable evidence', shouldPass: true });
run({ label: 'legacy metadata-only evidence', shouldPass: false, doc: { schemaVersion: 2, releaseVersion, subjects } });
run({ label: 'false verification', shouldPass: false, doc: document({ verification: { ...verification, verified: false } }) });
run({ label: 'unknown method', shouldPass: false, doc: document({ verification: { ...verification, method: 'checksum-only' } }) });
run({ label: 'subject drift', shouldPass: false, doc: document({ subjects: [{ ...subjects[0], sha256: subjects[2].sha256 }, subjects[1], subjects[2]] }) });
run({ label: 'release drift', shouldPass: false, doc: document({ releaseVersion: 'miner-v9.9.9' }) });
run({ label: 'unknown field', shouldPass: false, doc: document({ extra: true }) });
run({ label: 'digest mismatch', shouldPass: false, mutatePolicy: (p) => ({ ...p, evidence: { ...p.evidence, immutableRelease: p.evidence.immutableRelease.replace(/[0-9a-f]{64}$/, 'f'.repeat(64)) } }) });
run({ label: 'mutable ref', shouldPass: false, mutatePolicy: (p, c) => ({ ...p, evidence: { ...p.evidence, immutableRelease: p.evidence.immutableRelease.replace(`/blob/${c}/`, '/blob/main/') } }) });
run({ label: 'working-tree drift', shouldPass: false, mutateWorkingTree: (root) => writeFileSync(path.join(root, evidencePath), serialize(document({ verification: { ...verification, tool: 'different verifier' } }))) });
if (process.platform !== 'win32') run({ label: 'symlink evidence', shouldPass: false, symlinkEvidence: true });
console.log('miner immutable-release exact-Git-blob regressions: OK');
