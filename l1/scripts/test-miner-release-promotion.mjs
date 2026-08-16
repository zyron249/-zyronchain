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
run({ ...base, publicationAllowed: true }, false, 'publication without evidence');
run({ ...base, assets: { ...base.assets, windows: 'https://example.com/ZyronMiner.exe' } }, false, 'untrusted asset origin');
run({ ...base, assets: { ...base.assets, windows: 'https://github.com/zyron249/-zyronchain/releases/download/miner-v1.0.0/ZyronMiner-windows-x64.zip' } }, false, 'partial asset promotion');

const fullyEvidenced = {
  ...base,
  releaseVersion: 'miner-v1.0.0',
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  publicMiningActivated: true,
  releaseEligible: true,
  platformSigningVerified: true,
  provenanceVerified: true,
  checksumsVerified: true,
  immutableReleaseVerified: true,
  publicationAllowed: true,
  assets: {
    windows: 'https://github.com/zyron249/-zyronchain/releases/download/miner-v1.0.0/ZyronMiner-windows-x64.zip',
    macos: 'https://github.com/zyron249/-zyronchain/releases/download/miner-v1.0.0/ZyronMiner-macos-arm64.tar.gz',
    linux: 'https://github.com/zyron249/-zyronchain/releases/download/miner-v1.0.0/ZyronMiner-linux-x64.tar.gz'
  },
  evidence: {
    windowsSigning: 'evidence/windows-signing.json',
    macosSigningOrNotarization: 'evidence/macos-notarization.json',
    provenance: 'evidence/provenance.json',
    checksums: 'evidence/checksums.txt',
    immutableRelease: 'evidence/immutable-release.json',
    publicMiningActivation: 'evidence/public-mining-activation.json'
  }
};
run(fullyEvidenced, true, 'fully evidenced promotion vector');
run({ ...fullyEvidenced, immutableReleaseVerified: false }, false, 'mutable release');
run({ ...fullyEvidenced, sourceCommit: 'main' }, false, 'non-exact source identity');

console.log('miner release promotion gate regressions passed');
