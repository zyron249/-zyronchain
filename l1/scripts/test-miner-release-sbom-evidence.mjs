#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-sbom-evidence.mjs');
const canonical = path.resolve(here, '../../docs/miner-release-promotion.json');
const base = JSON.parse(fs.readFileSync(canonical, 'utf8'));

function run(policy, shouldPass, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-sbom-promotion-'));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(policy, null, 2));
  const result = spawnSync(process.execPath, [verifier, file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr}`);
  if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}

run(base, true, 'canonical inactive SBOM policy');
run({ ...base, sbomVerified: true }, false, 'inactive SBOM verification cannot be asserted');
run({ ...base, evidence: { ...base.evidence, windowsSbom: 'https://example.invalid/sbom#sha256=' + 'a'.repeat(64) } }, false, 'inactive policy cannot carry SBOM evidence');

const releaseVersion = 'miner-v1.2.3';
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const assets = {
  windows: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/ZyronMiner-windows-x64.zip`,
  macos: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/ZyronMiner-macos-arm64.tar.gz`,
  linux: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/ZyronMiner-linux-x64.tar.gz`
};
const active = {
  ...base,
  releaseVersion,
  sourceCommit,
  publicMiningActivated: true,
  releaseEligible: true,
  publicationAllowed: true,
  sbomVerified: true,
  assets,
  assetSha256: { windows: '1'.repeat(64), macos: '2'.repeat(64), linux: '3'.repeat(64) },
  evidence: {
    ...base.evidence,
    windowsSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/windows-signing.json#sha256=${'4'.repeat(64)}`,
    macosSigningOrNotarization: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/macos-notarization.json#sha256=${'5'.repeat(64)}`,
    provenance: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/provenance.json#sha256=${'6'.repeat(64)}`,
    checksums: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/SHA256SUMS#sha256=${'7'.repeat(64)}`,
    immutableRelease: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/immutable-release.json#sha256=${'8'.repeat(64)}`,
    publicMiningActivation: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/public-mining-activation.json#sha256=${'9'.repeat(64)}`,
    windowsSbom: `${assets.windows}.sbom.cdx.json#sha256=${'a'.repeat(64)}`,
    macosSbom: `${assets.macos}.sbom.cdx.json#sha256=${'b'.repeat(64)}`,
    linuxSbom: `${assets.linux}.sbom.cdx.json#sha256=${'c'.repeat(64)}`
  }
};
run(active, true, 'complete per-platform SBOM evidence');
run({ ...active, sbomVerified: false }, false, 'active promotion without SBOM verification');
run({ ...active, evidence: { ...active.evidence, linuxSbom: null } }, false, 'missing Linux SBOM');
run({ ...active, evidence: { ...active.evidence, macosSbom: active.evidence.windowsSbom } }, false, 'cross-platform SBOM substitution');
run({ ...active, evidence: { ...active.evidence, windowsSbom: `${assets.windows}.sbom.cdx.json` } }, false, 'digestless SBOM evidence');
run({ ...active, evidence: { ...active.evidence, windowsSbom: `${assets.windows}.sbom.cdx.json#sha256=${active.assetSha256.windows}` } }, false, 'SBOM digest aliases promoted artifact');
run({ ...active, evidence: { ...active.evidence, windowsSbom: `${assets.windows}.sbom.cdx.json#sha256=${'6'.repeat(64)}` } }, false, 'SBOM digest aliases provenance evidence');
run({ ...active, evidence: { ...active.evidence, macosSbom: `${assets.macos}.sbom.cdx.json#sha256=${'a'.repeat(64)}` } }, false, 'duplicate SBOM digest identity');
run({ ...active, evidence: { ...active.evidence, linuxSbom: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/ZyronMiner-windows-x64.zip.sbom.cdx.json#sha256=${'c'.repeat(64)}` } }, false, 'Linux slot uses Windows SBOM');
run({ ...active, evidence: { ...active.evidence, windowsSbom: `https://github.com/zyron249/-zyronchain/releases/download/miner-v1.2.4/ZyronMiner-windows-x64.zip.sbom.cdx.json#sha256=${'a'.repeat(64)}` } }, false, 'cross-release SBOM evidence');
run({ ...active, sourceCommit: sourceCommit.toUpperCase() }, false, 'non-canonical source commit');

console.log('miner release SBOM evidence regressions: OK');
