#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-miner-release-promotion.mjs');
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const releaseVersion = 'miner-v1.2.3';
const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${releaseVersion}/`;
const blobPrefix = `https://github.com/zyron249/-zyronchain/blob/${sourceCommit}/`;

const active = {
  schemaVersion: 4,
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
  assets: {
    windows: `${releasePrefix}ZyronMiner-windows-x64.zip`,
    macos: `${releasePrefix}ZyronMiner-macos-arm64.tar.gz`,
    linux: `${releasePrefix}ZyronMiner-linux-x64.tar.gz`
  },
  assetSha256: {
    windows: '1'.repeat(64),
    macos: '2'.repeat(64),
    linux: '3'.repeat(64)
  },
  evidence: {
    windowsSigning: `${blobPrefix}evidence/windows-signing.json#sha256=${'4'.repeat(64)}`,
    macosSigningOrNotarization: `${blobPrefix}evidence/macos-notarization.json#sha256=${'5'.repeat(64)}`,
    linuxSigning: `${blobPrefix}evidence/linux-signing.json#sha256=${'6'.repeat(64)}`,
    provenance: `${releasePrefix}provenance.json#sha256=${'7'.repeat(64)}`,
    checksums: `${releasePrefix}SHA256SUMS#sha256=${'8'.repeat(64)}`,
    windowsSbom: `${releasePrefix}ZyronMiner-windows-x64.zip.sbom.cdx.json#sha256=${'a'.repeat(64)}`,
    macosSbom: `${releasePrefix}ZyronMiner-macos-arm64.tar.gz.sbom.cdx.json#sha256=${'b'.repeat(64)}`,
    linuxSbom: `${releasePrefix}ZyronMiner-linux-x64.tar.gz.sbom.cdx.json#sha256=${'c'.repeat(64)}`,
    immutableRelease: `${blobPrefix}evidence/immutable-release.json#sha256=${'9'.repeat(64)}`,
    publicMiningActivation: `${blobPrefix}evidence/public-mining-activation.json#sha256=${'d'.repeat(64)}`
  }
};

function run(policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-sbom-baseline-'));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(policy, null, 2));
  const result = spawnSync(process.execPath, [verifier, file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

const positive = run(active);
if (positive.status !== 0) {
  throw new Error(`fully evidenced active policy should pass baseline verifier: ${positive.stderr || positive.stdout}`);
}

const falseSbom = run({ ...active, sbomVerified: false });
if (falseSbom.status === 0) {
  throw new Error('active promotion with sbomVerified=false must fail closed');
}
if (!`${falseSbom.stderr}${falseSbom.stdout}`.includes('promotion requires sbomVerified=true')) {
  throw new Error(`unexpected sbomVerified=false rejection: ${falseSbom.stderr || falseSbom.stdout}`);
}

console.log('baseline miner promotion verifier rejects active policies with sbomVerified=false');
