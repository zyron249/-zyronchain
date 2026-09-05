#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-signing-subjects.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const releaseVersion = 'miner-v1.0.0';
const assets = {
  windows: 'ZyronMiner-windows-x64.zip',
  macos: 'ZyronMiner-macos-arm64.tar.gz',
  linux: 'ZyronMiner-linux-x64.tar.gz'
};
const digests = { windows: '1'.repeat(64), macos: '2'.repeat(64), linux: '3'.repeat(64) };
const sbomDigests = { windows: 'a'.repeat(64), macos: 'b'.repeat(64), linux: 'c'.repeat(64) };
const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/`;
const evidencePaths = {
  windows: 'evidence/windows-signing.json',
  macos: 'evidence/macos-notarization.json',
  linux: 'evidence/linux-signing.json'
};
const evidenceFields = { windows: 'windowsSigning', macos: 'macosSigningOrNotarization', linux: 'linuxSigning' };
const verification = {
  windows: { verified: true, method: 'authenticode', tool: 'signtool verify /pa' },
  macos: { verified: true, method: 'notarization', tool: 'spctl --assess' },
  linux: { verified: true, method: 'detached-signature', tool: 'gpg --verify' }
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function subject(platform, overrides = {}) {
  const name = overrides.name || assets[platform];
  return {
    platform: overrides.platform || platform,
    name,
    sha256: overrides.sha256 || digests[platform],
    sbom: {
      name: overrides.sbomName || `${name}.sbom.cdx.json`,
      sha256: overrides.sbomSha256 || sbomDigests[platform]
    }
  };
}
function evidenceDocument(platform, overrides = {}) {
  return {
    schemaVersion: overrides.schemaVersion ?? 3,
    releaseVersion: overrides.releaseVersion ?? releaseVersion,
    subject: overrides.subject || subject(platform),
    verification: overrides.verification || verification[platform]
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
  git(root, ['commit', '-q', '-m', 'test signing evidence']);
  return git(root, ['rev-parse', 'HEAD']);
}
function activeSkeleton(sourceCommit, evidenceDigests) {
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
      windowsSigning: `${exactBlobPrefix}${evidencePaths.windows}#sha256=${evidenceDigests.windows}`,
      macosSigningOrNotarization: `${exactBlobPrefix}${evidencePaths.macos}#sha256=${evidenceDigests.macos}`,
      linuxSigning: `${exactBlobPrefix}${evidencePaths.linux}#sha256=${evidenceDigests.linux}`,
      provenance: `${releasePrefix}provenance.json#sha256=${'6'.repeat(64)}`,
      checksums: `${releasePrefix}SHA256SUMS#sha256=${'7'.repeat(64)}`,
      windowsSbom: `${releasePrefix}${assets.windows}.sbom.cdx.json#sha256=${sbomDigests.windows}`,
      macosSbom: `${releasePrefix}${assets.macos}.sbom.cdx.json#sha256=${sbomDigests.macos}`,
      linuxSbom: `${releasePrefix}${assets.linux}.sbom.cdx.json#sha256=${sbomDigests.linux}`,
      immutableRelease: `${exactBlobPrefix}evidence/immutable-release.json#sha256=${'8'.repeat(64)}`,
      publicMiningActivation: `${exactBlobPrefix}evidence/public-mining-activation.json#sha256=${'9'.repeat(64)}`,
      publication: `${exactBlobPrefix}evidence/publication.json#sha256=${'0'.repeat(63)}1`
    }
  };
}

function run({ label, shouldPass, documents = {}, mutatePolicy, omitEvidence = false, symlinkPlatform = null, mutateWorkingTree = null }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zyron-signing-evidence-'));
  const evidenceDir = path.join(root, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const evidenceDigests = {};

  for (const platform of ['windows', 'macos', 'linux']) {
    const document = documents[platform] || evidenceDocument(platform);
    const bytes = serialize(document);
    evidenceDigests[platform] = sha256(bytes);
    const target = path.join(root, evidencePaths[platform]);
    if (!omitEvidence || platform !== 'linux') writeFileSync(target, bytes);
  }

  if (symlinkPlatform && process.platform !== 'win32') {
    const target = path.join(root, evidencePaths[symlinkPlatform]);
    const real = `${target}.real`;
    const bytes = serialize(documents[symlinkPlatform] || evidenceDocument(symlinkPlatform));
    writeFileSync(real, bytes);
    rmSync(target, { force: true });
    symlinkSync(path.basename(real), target);
  }

  const sourceCommit = commitEvidence(root);
  let policy = activeSkeleton(sourceCommit, evidenceDigests);
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
  const root = mkdtempSync(path.join(os.tmpdir(), 'zyron-signing-inactive-'));
  const file = path.join(root, 'policy.json');
  writeFileSync(file, JSON.stringify(base, null, 2));
  const result = spawnSync(process.execPath, [verifier, file, root], { encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
  if (result.status !== 0) throw new Error(`inactive canonical policy should pass: ${result.stderr || result.stdout}`);
}

run({ label: 'structured Windows/macOS/Linux signing evidence', shouldPass: true });
run({
  label: 'metadata-only legacy signing evidence',
  shouldPass: false,
  documents: Object.fromEntries(['windows', 'macos', 'linux'].map((platform) => [platform, { schemaVersion: 2, releaseVersion, subject: subject(platform) }]))
});
run({
  label: 'explicitly false Windows verification',
  shouldPass: false,
  documents: { windows: evidenceDocument('windows', { verification: { ...verification.windows, verified: false } }) }
});
run({
  label: 'unapproved macOS verification method',
  shouldPass: false,
  documents: { macos: evidenceDocument('macos', { verification: { ...verification.macos, method: 'checksum-only' } }) }
});
run({
  label: 'Linux signing subject digest drift',
  shouldPass: false,
  documents: { linux: evidenceDocument('linux', { subject: subject('linux', { sha256: digests.windows }) }) }
});
run({ label: 'missing Linux signing evidence file', shouldPass: false, omitEvidence: true });
run({
  label: 'signing evidence digest mismatch',
  shouldPass: false,
  mutatePolicy: (policy) => ({ ...policy, evidence: { ...policy.evidence, windowsSigning: policy.evidence.windowsSigning.replace(/[0-9a-f]{64}$/, 'f'.repeat(64)) } })
});
run({
  label: 'mutable signing evidence reference',
  shouldPass: false,
  mutatePolicy: (policy, sourceCommit) => ({ ...policy, evidence: { ...policy.evidence, linuxSigning: policy.evidence.linuxSigning.replace(`/blob/${sourceCommit}/`, '/blob/main/') } })
});
run({
  label: 'working-tree evidence drift from exact sourceCommit',
  shouldPass: false,
  mutateWorkingTree: (root) => writeFileSync(path.join(root, evidencePaths.windows), serialize(evidenceDocument('windows', { verification: { ...verification.windows, tool: 'different tool' } })))
});
if (process.platform !== 'win32') {
  run({ label: 'symlink signing evidence', shouldPass: false, symlinkPlatform: 'linux' });
}

console.log('miner release structured platform-signing exact-Git-blob regressions: OK');
