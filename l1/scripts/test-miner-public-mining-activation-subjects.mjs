#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-public-mining-activation-subjects.mjs');
const base = JSON.parse(readFileSync(path.resolve(here, '../../docs/miner-release-promotion.json'), 'utf8'));
const releaseVersion = 'miner-v1.0.0';
const evidencePath = 'evidence/public-mining-activation.json';
const subjects = [
  { platform: 'windows', artifact: { name: 'ZyronMiner-windows-x64.zip', sha256: '1'.repeat(64) }, sbom: { name: 'ZyronMiner-windows-x64.zip.sbom.cdx.json', sha256: 'a'.repeat(64) } },
  { platform: 'macos', artifact: { name: 'ZyronMiner-macos-arm64.tar.gz', sha256: '2'.repeat(64) }, sbom: { name: 'ZyronMiner-macos-arm64.tar.gz.sbom.cdx.json', sha256: 'b'.repeat(64) } },
  { platform: 'linux', artifact: { name: 'ZyronMiner-linux-x64.tar.gz', sha256: '3'.repeat(64) }, sbom: { name: 'ZyronMiner-linux-x64.tar.gz.sbom.cdx.json', sha256: 'c'.repeat(64) } }
];
const evidenceDocument = (overrides = {}) => ({
  schemaVersion: 3,
  releaseVersion,
  subjects,
  verification: { verified: true, method: 'public-mining-activation-review', tool: 'zyron-release-activation-verifier/1', },
  ...overrides
});

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}
function makeRepo(document = evidenceDocument()) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'zyron-public-mining-evidence-'));
  mkdirSync(path.join(repo, 'evidence'), { recursive: true });
  writeFileSync(path.join(repo, evidencePath), `${JSON.stringify(document)}\n`);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'ci@example.invalid']);
  git(repo, ['config', 'user.name', 'Zyron CI']);
  git(repo, ['add', evidencePath]);
  git(repo, ['commit', '-qm', 'fixture']);
  const sourceCommit = git(repo, ['rev-parse', 'HEAD']);
  const bytes = readFileSync(path.join(repo, evidencePath));
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { repo, sourceCommit, digest };
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
      publicMiningActivation: `${blobPrefix}${evidencePath}#sha256=${digest}`,
      publication: `${blobPrefix}evidence/publication.json#sha256=${'0'.repeat(63)}1`
    }
  };
}
function runFixture({ document = evidenceDocument(), mutatePolicy, mutateTree, shouldPass, label }) {
  const { repo, sourceCommit, digest } = makeRepo(document);
  const policy = policyFor(sourceCommit, digest);
  const finalPolicy = mutatePolicy ? mutatePolicy(policy) : policy;
  if (mutateTree) mutateTree(repo);
  const policyFile = path.join(repo, 'policy.json');
  writeFileSync(policyFile, JSON.stringify(finalPolicy, null, 2));
  const result = spawnSync(process.execPath, [verifier, policyFile, repo], { encoding: 'utf8' });
  rmSync(repo, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr || result.stdout}`);
  if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}

const inactiveDir = mkdtempSync(path.join(os.tmpdir(), 'zyron-public-mining-inactive-'));
const inactiveFile = path.join(inactiveDir, 'policy.json');
writeFileSync(inactiveFile, JSON.stringify(base, null, 2));
const inactive = spawnSync(process.execPath, [verifier, inactiveFile, inactiveDir], { encoding: 'utf8' });
rmSync(inactiveDir, { recursive: true, force: true });
if (inactive.status !== 0) throw new Error(`inactive canonical policy should pass: ${inactive.stderr || inactive.stdout}`);

runFixture({ shouldPass: true, label: 'exact immutable public mining activation evidence' });
runFixture({ document: evidenceDocument({ verification: { verified: false, method: 'public-mining-activation-review', tool: 'zyron-release-activation-verifier/1' } }), shouldPass: false, label: 'false verification' });
runFixture({ document: evidenceDocument({ verification: { verified: true, method: 'unknown-method', tool: 'zyron-release-activation-verifier/1' } }), shouldPass: false, label: 'unknown verification method' });
runFixture({ document: evidenceDocument({ releaseVersion: 'miner-v1.0.1' }), shouldPass: false, label: 'release drift' });
runFixture({ document: evidenceDocument({ subjects: subjects.slice(0, 2) }), shouldPass: false, label: 'missing subject' });
runFixture({ document: { ...evidenceDocument(), unexpected: true }, shouldPass: false, label: 'unknown evidence field' });
runFixture({ mutatePolicy: (p) => ({ ...p, evidence: { ...p.evidence, publicMiningActivation: p.evidence.publicMiningActivation.replace(/#sha256=[0-9a-f]{64}$/, `#sha256=${'f'.repeat(64)}`) } }), shouldPass: false, label: 'evidence digest mismatch' });
runFixture({ mutatePolicy: (p) => ({ ...p, evidence: { ...p.evidence, publicMiningActivation: p.evidence.publicMiningActivation.replace(`/blob/${p.sourceCommit}/`, '/blob/main/') } }), shouldPass: false, label: 'mutable evidence ref' });
runFixture({ mutatePolicy: (p) => ({ ...p, assetSha256: { ...p.assetSha256, windows: p.assetSha256.linux } }), shouldPass: false, label: 'policy artifact subject drift' });
runFixture({ mutatePolicy: (p) => ({ ...p, evidence: { ...p.evidence, windowsSbom: p.evidence.windowsSbom.replace(subjects[0].sbom.sha256, 'f'.repeat(64)) } }), shouldPass: false, label: 'policy SBOM subject drift' });
runFixture({ mutateTree: (repo) => writeFileSync(path.join(repo, evidencePath), `${JSON.stringify(evidenceDocument({ verification: { verified: false, method: 'public-mining-activation-review', tool: 'zyron-release-activation-verifier/1' } }))}\n`), shouldPass: false, label: 'working-tree substitution' });
runFixture({ mutateTree: (repo) => { const target = path.join(repo, 'replacement.json'); writeFileSync(target, `${JSON.stringify(evidenceDocument())}\n`); rmSync(path.join(repo, evidencePath)); symlinkSync(target, path.join(repo, evidencePath)); }, shouldPass: false, label: 'symlink substitution' });

console.log('public mining activation immutable evidence regressions: OK');
