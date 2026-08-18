#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-promotion.mjs');
const canonical = path.resolve(here, '../../docs/miner-release-promotion.json');
const base = JSON.parse(fs.readFileSync(canonical, 'utf8'));

function run(policy, shouldPass, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-promotion-'));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(policy, null, 2));
  const result = spawnSync(process.execPath, [verifier, file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (shouldPass && result.status !== 0) throw new Error(`${label} should pass: ${result.stderr}`);
  if (!shouldPass && result.status === 0) throw new Error(`${label} should fail`);
}

run(base, true, 'canonical fail-closed policy');
run({ ...base, assets: {} }, false, 'empty platform asset set');
run({ ...base, assets: { windows: null, macos: null } }, false, 'missing Linux platform key');
run({ ...base, assets: { ...base.assets, freebsd: null } }, false, 'unexpected platform key');
run({ ...base, evidence: {} }, false, 'empty promotion evidence set');
const { publicMiningActivation: _inactiveMissingEvidence, ...inactiveMissingEvidence } = base.evidence;
run({ ...base, evidence: inactiveMissingEvidence }, false, 'missing inactive promotion evidence key');
run({ ...base, evidence: { ...base.evidence, operatorNote: null } }, false, 'unexpected inactive promotion evidence key');
run({ ...base, publicationAllowed: true }, false, 'publication without evidence');
run({ ...base, assets: { ...base.assets, windows: 'https://example.com/ZyronMiner.exe' } }, false, 'untrusted asset origin');
run({ ...base, assets: { ...base.assets, windows: 'https://github.com/zyron249/-zyronchain/releases/download/miner-v1.0.0/ZyronMiner-windows-x64.zip' } }, false, 'partial asset promotion');

const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const releaseVersion = 'miner-v1.0.0';
const digest = 'a'.repeat(64);
const fullyEvidenced = {
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
  assets: {
    windows: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/ZyronMiner-windows-x64.zip`,
    macos: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/ZyronMiner-macos-arm64.tar.gz`,
    linux: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/ZyronMiner-linux-x64.tar.gz`
  },
  evidence: {
    windowsSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/windows-signing.json#sha256=${digest}`,
    macosSigningOrNotarization: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/macos-notarization.json#sha256=${digest}`,
    provenance: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/provenance.json#sha256=${digest}`,
    checksums: `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/SHA256SUMS#sha256=${digest}`,
    immutableRelease: `https://github.com/zyron249/-zyronchain/releases/tag/${releaseVersion}#sha256=${digest}`,
    publicMiningActivation: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/public-mining-activation.json#sha256=${digest}`
  }
};
run(fullyEvidenced, true, 'fully evidenced promotion vector');
run({ ...fullyEvidenced, assets: {} }, false, 'activated promotion without platform assets');
run({ ...fullyEvidenced, assets: { windows: fullyEvidenced.assets.windows, macos: fullyEvidenced.assets.macos } }, false, 'activated promotion missing Linux asset');
const { checksums: _missingPromotedChecksums, ...promotedMissingEvidence } = fullyEvidenced.evidence;
run({ ...fullyEvidenced, evidence: promotedMissingEvidence }, false, 'activated promotion missing checksums evidence');
run({ ...fullyEvidenced, evidence: { ...fullyEvidenced.evidence, operatorNote: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/operator-note.json#sha256=${digest}` } }, false, 'activated promotion with unexpected evidence key');
run({ ...fullyEvidenced, immutableReleaseVerified: false }, false, 'mutable release');
run({ ...fullyEvidenced, sourceCommit: 'main' }, false, 'non-exact source identity');
run({ ...fullyEvidenced, evidence: { ...fullyEvidenced.evidence, provenance: 'trust-me-provenance' } }, false, 'placeholder evidence');
run({ ...fullyEvidenced, evidence: { ...fullyEvidenced.evidence, checksums: `https://github.com/zyron249/-zyronchain/blob/main/evidence/checksums.txt#sha256=${digest}` } }, false, 'mutable branch evidence');
run({ ...fullyEvidenced, evidence: { ...fullyEvidenced.evidence, windowsSigning: `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/evidence/windows-signing.json` } }, false, 'evidence without digest binding');
run({ ...fullyEvidenced, assets: { ...fullyEvidenced.assets, linux: 'https://github.com/zyron249/-zyronchain/releases/download/miner-v1.0.1/ZyronMiner-linux-x64.tar.gz' } }, false, 'cross-tag asset');
run({ ...fullyEvidenced, evidence: { ...fullyEvidenced.evidence, immutableRelease: `https://github.com/zyron249/-zyronchain/releases/tag/miner-v1.0.1#sha256=${digest}` } }, false, 'cross-tag release evidence');

console.log('miner release promotion gate regressions passed');
