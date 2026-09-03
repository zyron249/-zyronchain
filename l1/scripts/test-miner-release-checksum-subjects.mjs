#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-checksum-subjects.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const releaseVersion = 'miner-v1.0.0';
const evidencePath = 'evidence/checksums.json';
const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/`;
const artifactSubjects = [
  { platform: 'windows', name: 'ZyronMiner-windows-x64.zip', sha256: '1'.repeat(64) },
  { platform: 'macos', name: 'ZyronMiner-macos-arm64.tar.gz', sha256: '2'.repeat(64) },
  { platform: 'linux', name: 'ZyronMiner-linux-x64.tar.gz', sha256: '3'.repeat(64) }
];
const sbomSubjects = [
  { platform: 'windows', name: `${artifactSubjects[0].name}.sbom.cdx.json`, sha256: 'a'.repeat(64) },
  { platform: 'macos', name: `${artifactSubjects[1].name}.sbom.cdx.json`, sha256: 'b'.repeat(64) },
  { platform: 'linux', name: `${artifactSubjects[2].name}.sbom.cdx.json`, sha256: 'c'.repeat(64) }
];
const checksumAsset = { name: 'SHA256SUMS', url: `${releasePrefix}SHA256SUMS`, sha256: 'e'.repeat(64) };
const verification = { verified: true, method: 'sha256sum-manifest', tool: 'sha256sum --check SHA256SUMS' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const document = (overrides = {}) => ({
  schemaVersion: overrides.schemaVersion ?? 3,
  releaseVersion: overrides.releaseVersion ?? releaseVersion,
  artifactSubjects: overrides.artifactSubjects ?? artifactSubjects,
  sbomSubjects: overrides.sbomSubjects ?? sbomSubjects,
  checksumAsset: overrides.checksumAsset ?? checksumAsset,
  verification: overrides.verification ?? verification,
  ...(overrides.extra ? { extra: true } : {})
});
const serialize = (value) => `${JSON.stringify(value)}\n`;
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function commitEvidence(root) {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Zyron Test']);
  git(root, ['config', 'user.email', 'zyron-test@example.invalid']);
  git(root, ['add', 'evidence']);
  git(root, ['commit', '-q', '-m', 'test checksum evidence']);
  return git(root, ['rev-parse', 'HEAD']);
}
function active(sourceCommit, digest) {
  const exact = `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/`;
  return {
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
    assets: Object.fromEntries(artifactSubjects.map((s) => [s.platform, `${releasePrefix}${s.name}`])),
    assetSha256: Object.fromEntries(artifactSubjects.map((s) => [s.platform, s.sha256])),
    evidence: {
      ...base.evidence,
      windowsSigning: `${exact}evidence/windows-signing.json#sha256=${'4'.repeat(64)}`,
      macosSigningOrNotarization: `${exact}evidence/macos-notarization.json#sha256=${'5'.repeat(64)}`,
      linuxSigning: `${exact}evidence/linux-signing.json#sha256=${'d'.repeat(64)}`,
      provenance: `${exact}evidence/provenance.json#sha256=${'6'.repeat(64)}`,
      checksums: `${exact}${evidencePath}#sha256=${digest}`,
      windowsSbom: `${releasePrefix}${sbomSubjects[0].name}#sha256=${sbomSubjects[0].sha256}`,
      macosSbom: `${releasePrefix}${sbomSubjects[1].name}#sha256=${sbomSubjects[1].sha256}`,
      linuxSbom: `${releasePrefix}${sbomSubjects[2].name}#sha256=${sbomSubjects[2].sha256}`,
      immutableRelease: `${exact}evidence/immutable-release.json#sha256=${'8'.repeat(64)}`,
      publicMiningActivation: `${exact}evidence/public-mining-activation.json#sha256=${'9'.repeat(64)}`
    }
  };
}
function run({ label, shouldPass, doc = document(), mutatePolicy, mutateWorkingTree, symlinkEvidence = false }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zyron-checksum-evidence-'));
  mkdirSync(path.join(root, 'evidence'), { recursive: true });
  const target = path.join(root, evidencePath);
  const bytes = serialize(doc);
  writeFileSync(target, bytes);
  if (symlinkEvidence && process.platform !== 'win32') {
    const real = `${target}.real`;
    writeFileSync(real, bytes);
    rmSync(target);
    symlinkSync(path.basename(real), target);
  }
  const sourceCommit = commitEvidence(root);
  let policy = active(sourceCommit, sha256(bytes));
  if (mutatePolicy) policy = mutatePolicy(policy, sourceCommit);
  if (mutateWorkingTree) mutateWorkingTree(root);
  const policyFile = path.join(root, 'policy.json');
  writeFileSync(policyFile, JSON.stringify(policy, null, 2));
  const result = spawnSync(process.execPath, [verifier, policyFile, root], { encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr || result.stdout}`);
  if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}

{
  const root = mkdtempSync(path.join(os.tmpdir(), 'zyron-checksum-inactive-'));
  const policyFile = path.join(root, 'policy.json');
  writeFileSync(policyFile, JSON.stringify(base));
  const result = spawnSync(process.execPath, [verifier, policyFile, root], { encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
  if (result.status !== 0) throw new Error('inactive canonical policy should pass');
}
run({ label: 'structured exact checksum evidence', shouldPass: true });
run({ label: 'legacy metadata-only evidence', shouldPass: false, doc: { schemaVersion: 2, releaseVersion, artifactSubjects, sbomSubjects } });
run({ label: 'false verification', shouldPass: false, doc: document({ verification: { ...verification, verified: false } }) });
run({ label: 'unknown method', shouldPass: false, doc: document({ verification: { ...verification, method: 'metadata-only' } }) });
run({ label: 'artifact subject drift', shouldPass: false, doc: document({ artifactSubjects: [{ ...artifactSubjects[0], sha256: artifactSubjects[2].sha256 }, artifactSubjects[1], artifactSubjects[2]] }) });
run({ label: 'SBOM subject drift', shouldPass: false, doc: document({ sbomSubjects: [{ ...sbomSubjects[0], sha256: sbomSubjects[2].sha256 }, sbomSubjects[1], sbomSubjects[2]] }) });
run({ label: 'release drift', shouldPass: false, doc: document({ releaseVersion: 'miner-v9.9.9' }) });
run({ label: 'checksum asset URL drift', shouldPass: false, doc: document({ checksumAsset: { ...checksumAsset, url: `${releasePrefix}checksums.txt` } }) });
run({ label: 'checksum asset digest alias', shouldPass: false, doc: document({ checksumAsset: { ...checksumAsset, sha256: artifactSubjects[0].sha256 } }) });
run({ label: 'unknown field', shouldPass: false, doc: document({ extra: true }) });
run({ label: 'digest mismatch', shouldPass: false, mutatePolicy: (p) => ({ ...p, evidence: { ...p.evidence, checksums: p.evidence.checksums.replace(/[0-9a-f]{64}$/, 'f'.repeat(64)) } }) });
run({ label: 'mutable ref', shouldPass: false, mutatePolicy: (p, c) => ({ ...p, evidence: { ...p.evidence, checksums: p.evidence.checksums.replace(`/blob/${c}/`, '/blob/main/') } }) });
run({ label: 'release asset substitution', shouldPass: false, mutatePolicy: (p) => ({ ...p, evidence: { ...p.evidence, checksums: `${releasePrefix}SHA256SUMS#sha256=${p.evidence.checksums.slice(-64)}` } }) });
run({ label: 'working-tree drift', shouldPass: false, mutateWorkingTree: (root) => writeFileSync(path.join(root, evidencePath), serialize(document({ verification: { ...verification, tool: 'different checksum verifier' } }))) });
if (process.platform !== 'win32') run({ label: 'symlink evidence', shouldPass: false, symlinkEvidence: true });
run({ label: 'partial activation state', shouldPass: false, mutatePolicy: () => ({ ...base, checksumsVerified: true }) });

console.log('miner checksum exact-Git-blob regressions: OK');
