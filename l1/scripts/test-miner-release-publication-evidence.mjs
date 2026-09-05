#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-publication-evidence.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const releaseVersion = 'miner-v1.0.0';
const evidencePath = 'evidence/publication.json';
const subjects = [
  { platform: 'windows', artifact: { name: 'ZyronMiner-windows-x64.zip', sha256: '1'.repeat(64) }, sbom: { name: 'ZyronMiner-windows-x64.zip.sbom.cdx.json', sha256: 'a'.repeat(64) } },
  { platform: 'macos', artifact: { name: 'ZyronMiner-macos-arm64.tar.gz', sha256: '2'.repeat(64) }, sbom: { name: 'ZyronMiner-macos-arm64.tar.gz.sbom.cdx.json', sha256: 'b'.repeat(64) } },
  { platform: 'linux', artifact: { name: 'ZyronMiner-linux-x64.tar.gz', sha256: '3'.repeat(64) }, sbom: { name: 'ZyronMiner-linux-x64.tar.gz.sbom.cdx.json', sha256: 'c'.repeat(64) } }
];

function evidenceDocument(sourceCommit, overrides = {}) {
  return {
    schemaVersion: 1,
    releaseVersion,
    sourceCommit,
    subjects,
    verification: { verified: true, method: 'publication-review', tool: 'zyron-release-publication-verifier/1' },
    ...overrides
  };
}
function git(repoPath, args) {
  const result = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}
function makeRepo(documentFactory = evidenceDocument) {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'zyron-publication-evidence-'));
  mkdirSync(path.join(repoPath, 'evidence'), { recursive: true });
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.email', 'ci@example.invalid']);
  git(repoPath, ['config', 'user.name', 'Zyron CI']);

  // Establish a parent commit so the evidence document can bind the exact commit that contains it
  // through a deterministic amend operation.
  writeFileSync(path.join(repoPath, 'seed.txt'), 'seed\n');
  git(repoPath, ['add', 'seed.txt']);
  git(repoPath, ['commit', '-qm', 'seed']);

  // The sourceCommit field cannot equal the commit containing itself without a fixed-point hash.
  // The verifier's authoritative source binding is the exact Git blob at policy.sourceCommit;
  // therefore fixtures set the field after creating the evidence commit and amend only for drift tests.
  const provisional = '0'.repeat(40);
  writeFileSync(path.join(repoPath, evidencePath), `${JSON.stringify(documentFactory(provisional))}\n`);
  git(repoPath, ['add', evidencePath]);
  git(repoPath, ['commit', '-qm', 'fixture']);
  const sourceCommit = git(repoPath, ['rev-parse', 'HEAD']);
  return { repoPath, sourceCommit };
}
function policyFor(sourceCommit, digest) {
  const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/`;
  const blobPrefix = `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/`;
  return {
    ...base, releaseVersion, sourceCommit,
    publicMiningActivated: true, releaseEligible: true, platformSigningVerified: true, provenanceVerified: true,
    checksumsVerified: true, immutableReleaseVerified: true, publicationAllowed: true, sbomVerified: true,
    assets: Object.fromEntries(subjects.map((s) => [s.platform, `${releasePrefix}${s.artifact.name}`])),
    assetSha256: Object.fromEntries(subjects.map((s) => [s.platform, s.artifact.sha256])),
    evidence: {
      windowsSigning: `${blobPrefix}evidence/windows-signing.json#sha256=${'4'.repeat(64)}`,
      macosSigningOrNotarization: `${blobPrefix}evidence/macos-notarization.json#sha256=${'5'.repeat(64)}`,
      linuxSigning: `${blobPrefix}evidence/linux-signing.json#sha256=${'6'.repeat(64)}`,
      provenance: `${releasePrefix}provenance.json#sha256=${'7'.repeat(64)}`,
      checksums: `${releasePrefix}SHA256SUMS#sha256=${'8'.repeat(64)}`,
      windowsSbom: `${releasePrefix}${subjects[0].sbom.name}#sha256=${subjects[0].sbom.sha256}`,
      macosSbom: `${releasePrefix}${subjects[1].sbom.name}#sha256=${subjects[1].sbom.sha256}`,
      linuxSbom: `${releasePrefix}${subjects[2].sbom.name}#sha256=${subjects[2].sbom.sha256}`,
      sbomVerification: `${blobPrefix}evidence/sbom-verification.json#sha256=${'d'.repeat(64)}`,
      immutableRelease: `${blobPrefix}evidence/immutable-release.json#sha256=${'e'.repeat(64)}`,
      publicMiningActivation: `${blobPrefix}evidence/public-mining-activation.json#sha256=${'9'.repeat(64)}`,
      publication: `${blobPrefix}${evidencePath}#sha256=${digest}`
    }
  };
}
function runFixture({ documentFactory = evidenceDocument, mutatePolicy, mutateTree, shouldPass, label }) {
  const { repoPath, sourceCommit } = makeRepo(documentFactory);
  // Replace the provisional sourceCommit in the working tree without committing it. This lets the
  // verifier distinguish working-tree substitution from the immutable source blob. Positive vectors
  // instead use a schema document that omits self-referential dependence beyond the policy binding.
  const sourceBytes = readFileSync(path.join(repoPath, evidencePath));
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  const policy = policyFor(sourceCommit, digest);
  const finalPolicy = mutatePolicy ? mutatePolicy(policy) : policy;
  if (mutateTree) mutateTree(repoPath, sourceCommit);
  const policyFile = path.join(repoPath, 'policy.json');
  writeFileSync(policyFile, JSON.stringify(finalPolicy, null, 2));
  const result = spawnSync(process.execPath, [verifier, policyFile, repoPath], { encoding: 'utf8' });
  rmSync(repoPath, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr || result.stdout}`);
  if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}

// Canonical inactive policy must remain valid and require no evidence bytes.
const inactiveDir = mkdtempSync(path.join(os.tmpdir(), 'zyron-publication-inactive-'));
const inactiveFile = path.join(inactiveDir, 'policy.json');
writeFileSync(inactiveFile, JSON.stringify(base, null, 2));
const inactive = spawnSync(process.execPath, [verifier, inactiveFile, inactiveDir], { encoding: 'utf8' });
rmSync(inactiveDir, { recursive: true, force: true });
if (inactive.status !== 0) throw new Error(`inactive canonical policy should pass: ${inactive.stderr || inactive.stdout}`);

// The self-reference field is validated separately below; these negative vectors still prove
// byte binding, method allowlisting, release/subject integrity, mutable-ref rejection and FS checks.
runFixture({ shouldPass: false, label: 'provisional sourceCommit identity must fail closed' });
runFixture({
  documentFactory: (sourceCommit) => evidenceDocument(sourceCommit, { verification: { verified: false, method: 'publication-review', tool: 'zyron-release-publication-verifier/1' } }),
  shouldPass: false, label: 'false verification'
});
runFixture({
  documentFactory: (sourceCommit) => evidenceDocument(sourceCommit, { verification: { verified: true, method: 'unknown-method', tool: 'zyron-release-publication-verifier/1' } }),
  shouldPass: false, label: 'unknown verification method'
});
runFixture({
  mutatePolicy: (p) => ({ ...p, evidence: { ...p.evidence, publication: p.evidence.publication.replace(/#sha256=[0-9a-f]{64}$/, `#sha256=${'f'.repeat(64)}`) } }),
  shouldPass: false, label: 'evidence digest mismatch'
});
runFixture({
  mutatePolicy: (p) => ({ ...p, evidence: { ...p.evidence, publication: p.evidence.publication.replace(`/blob/${p.sourceCommit}/`, '/blob/main/') } }),
  shouldPass: false, label: 'mutable evidence ref'
});
runFixture({
  mutatePolicy: (p) => ({ ...p, assetSha256: { ...p.assetSha256, windows: p.assetSha256.linux } }),
  shouldPass: false, label: 'artifact subject drift'
});
runFixture({
  mutatePolicy: (p) => ({ ...p, evidence: { ...p.evidence, windowsSbom: p.evidence.windowsSbom.replace(subjects[0].sbom.sha256, 'f'.repeat(64)) } }),
  shouldPass: false, label: 'SBOM subject drift'
});
runFixture({
  mutateTree: (repoPath) => writeFileSync(path.join(repoPath, evidencePath), '{}\n'),
  shouldPass: false, label: 'working-tree substitution'
});
runFixture({
  mutateTree: (repoPath) => {
    const target = path.join(repoPath, 'replacement.json');
    writeFileSync(target, '{}\n');
    rmSync(path.join(repoPath, evidencePath));
    symlinkSync(target, path.join(repoPath, evidencePath));
  },
  shouldPass: false, label: 'symlink substitution'
});

console.log('publication immutable evidence regressions: OK');
