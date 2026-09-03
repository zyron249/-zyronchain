#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-provenance-subjects.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const releaseVersion = 'miner-v1.0.0';
const evidencePath = 'evidence/provenance.json';
const assets = {
  windows: 'ZyronMiner-windows-x64.zip',
  macos: 'ZyronMiner-macos-arm64.tar.gz',
  linux: 'ZyronMiner-linux-x64.tar.gz'
};
const digests = { windows: '1'.repeat(64), macos: '2'.repeat(64), linux: '3'.repeat(64) };
const sbomDigests = { windows: 'a'.repeat(64), macos: 'b'.repeat(64), linux: 'c'.repeat(64) };
const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/`;
const artifactSubjects = ['windows', 'macos', 'linux'].map((platform) => ({
  platform,
  name: assets[platform],
  sha256: digests[platform]
}));
const sbomSubjects = ['windows', 'macos', 'linux'].map((platform) => ({
  platform,
  name: `${assets[platform]}.sbom.cdx.json`,
  sha256: sbomDigests[platform]
}));
const verification = { verified: true, method: 'slsa-provenance', tool: 'slsa-verifier verify-artifact' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function provenanceDocument(overrides = {}) {
  return {
    schemaVersion: overrides.schemaVersion ?? 3,
    releaseVersion: overrides.releaseVersion ?? releaseVersion,
    artifactSubjects: overrides.artifactSubjects ?? artifactSubjects,
    sbomSubjects: overrides.sbomSubjects ?? sbomSubjects,
    verification: overrides.verification ?? verification,
    ...(overrides.extra ? { extra: overrides.extra } : {})
  };
}
function serialize(document) {
  return `${JSON.stringify(document)}\n`;
}
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
  git(root, ['commit', '-q', '-m', 'test provenance evidence']);
  return git(root, ['rev-parse', 'HEAD']);
}
function activeSkeleton(sourceCommit, provenanceDigest) {
  const exactBlobPrefix = `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/`;
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
    assets: Object.fromEntries(Object.entries(assets).map(([platform, name]) => [platform, `${releasePrefix}${name}`])),
    assetSha256: digests,
    evidence: {
      ...base.evidence,
      windowsSigning: `${exactBlobPrefix}evidence/windows-signing.json#sha256=${'4'.repeat(64)}`,
      macosSigningOrNotarization: `${exactBlobPrefix}evidence/macos-notarization.json#sha256=${'5'.repeat(64)}`,
      linuxSigning: `${exactBlobPrefix}evidence/linux-signing.json#sha256=${'d'.repeat(64)}`,
      provenance: `${exactBlobPrefix}${evidencePath}#sha256=${provenanceDigest}`,
      checksums: `${releasePrefix}SHA256SUMS#sha256=${'7'.repeat(64)}`,
      windowsSbom: `${releasePrefix}${assets.windows}.sbom.cdx.json#sha256=${sbomDigests.windows}`,
      macosSbom: `${releasePrefix}${assets.macos}.sbom.cdx.json#sha256=${sbomDigests.macos}`,
      linuxSbom: `${releasePrefix}${assets.linux}.sbom.cdx.json#sha256=${sbomDigests.linux}`,
      immutableRelease: `${exactBlobPrefix}evidence/immutable-release.json#sha256=${'8'.repeat(64)}`,
      publicMiningActivation: `${exactBlobPrefix}evidence/public-mining-activation.json#sha256=${'9'.repeat(64)}`
    }
  };
}

function run({ label, shouldPass, document = provenanceDocument(), mutatePolicy, omitEvidence = false, symlinkEvidence = false, mutateWorkingTree = null }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zyron-provenance-evidence-'));
  const evidenceDir = path.join(root, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const bytes = serialize(document);
  const target = path.join(root, evidencePath);

  if (!omitEvidence) writeFileSync(target, bytes);
  if (symlinkEvidence && process.platform !== 'win32') {
    const real = `${target}.real`;
    writeFileSync(real, bytes);
    rmSync(target, { force: true });
    symlinkSync(path.basename(real), target);
  }

  const sourceCommit = commitEvidence(root);
  let policy = activeSkeleton(sourceCommit, sha256(bytes));
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
  const root = mkdtempSync(path.join(os.tmpdir(), 'zyron-provenance-inactive-'));
  const file = path.join(root, 'policy.json');
  writeFileSync(file, JSON.stringify(base, null, 2));
  const result = spawnSync(process.execPath, [verifier, file, root], { encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
  if (result.status !== 0) throw new Error(`inactive canonical policy should pass: ${result.stderr || result.stdout}`);
}

run({ label: 'structured immutable provenance evidence', shouldPass: true });
run({
  label: 'metadata-only legacy provenance evidence',
  shouldPass: false,
  document: { schemaVersion: 2, releaseVersion, artifactSubjects, sbomSubjects }
});
run({
  label: 'explicitly false provenance verification',
  shouldPass: false,
  document: provenanceDocument({ verification: { ...verification, verified: false } })
});
run({
  label: 'unapproved provenance verification method',
  shouldPass: false,
  document: provenanceDocument({ verification: { ...verification, method: 'checksum-only' } })
});
run({
  label: 'artifact subject digest drift',
  shouldPass: false,
  document: provenanceDocument({ artifactSubjects: [{ ...artifactSubjects[0], sha256: digests.linux }, artifactSubjects[1], artifactSubjects[2]] })
});
run({
  label: 'SBOM subject platform swap',
  shouldPass: false,
  document: provenanceDocument({ sbomSubjects: [sbomSubjects[2], sbomSubjects[1], sbomSubjects[0]] })
});
run({
  label: 'release identity drift',
  shouldPass: false,
  document: provenanceDocument({ releaseVersion: 'miner-v9.9.9' })
});
run({
  label: 'unknown provenance field',
  shouldPass: false,
  document: provenanceDocument({ extra: true })
});
run({ label: 'missing provenance evidence file', shouldPass: false, omitEvidence: true });
run({
  label: 'provenance digest mismatch',
  shouldPass: false,
  mutatePolicy: (policy) => ({ ...policy, evidence: { ...policy.evidence, provenance: policy.evidence.provenance.replace(/[0-9a-f]{64}$/, 'f'.repeat(64)) } })
});
run({
  label: 'mutable provenance evidence reference',
  shouldPass: false,
  mutatePolicy: (policy, sourceCommit) => ({ ...policy, evidence: { ...policy.evidence, provenance: policy.evidence.provenance.replace(`/blob/${sourceCommit}/`, '/blob/main/') } })
});
run({
  label: 'release-asset provenance reference is not exact source evidence',
  shouldPass: false,
  mutatePolicy: (policy) => ({ ...policy, evidence: { ...policy.evidence, provenance: `${releasePrefix}provenance.json#sha256=${policy.evidence.provenance.slice(-64)}` } })
});
run({
  label: 'working-tree provenance drift from exact sourceCommit',
  shouldPass: false,
  mutateWorkingTree: (root) => writeFileSync(path.join(root, evidencePath), serialize(provenanceDocument({ verification: { ...verification, tool: 'different verifier' } })))
});
if (process.platform !== 'win32') {
  run({ label: 'symlink provenance evidence', shouldPass: false, symlinkEvidence: true });
}

console.log('miner release structured provenance exact-Git-blob regressions: OK');
