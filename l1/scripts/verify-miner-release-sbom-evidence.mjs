#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || path.resolve(process.cwd(), '../docs/miner-release-promotion.json');
const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
const platforms = ['windows', 'macos', 'linux'];
const sbomKeys = { windows: 'windowsSbom', macos: 'macosSbom', linux: 'linuxSbom' };

if (policy.schemaVersion !== 4) throw new Error('SBOM promotion gate requires schemaVersion=4');
if (typeof policy.sbomVerified !== 'boolean') throw new Error('sbomVerified must be boolean');
if (!policy.evidence || typeof policy.evidence !== 'object' || Array.isArray(policy.evidence)) throw new Error('evidence object required');
for (const key of Object.values(sbomKeys)) {
  if (!(key in policy.evidence)) throw new Error(`missing ${key} evidence slot`);
}

const anyActivation = policy.publicMiningActivated === true || policy.releaseEligible === true || policy.publicationAllowed === true ||
  Object.values(policy.assets || {}).some((value) => value !== null) || Object.values(policy.assetSha256 || {}).some((value) => value !== null);
if (!anyActivation) {
  if (policy.sbomVerified !== false) throw new Error('inactive promotion must keep sbomVerified=false');
  for (const key of Object.values(sbomKeys)) {
    if (policy.evidence[key] !== null) throw new Error(`inactive promotion must not carry ${key} evidence`);
  }
  console.log('miner release SBOM evidence remains fail-closed');
  process.exit(0);
}

if (policy.sbomVerified !== true) throw new Error('promotion requires sbomVerified=true');
if (!/^[0-9a-f]{40}$/.test(policy.sourceCommit || '')) throw new Error('SBOM evidence requires exact sourceCommit');
if (!/^miner-v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(policy.releaseVersion || '')) throw new Error('SBOM evidence requires canonical releaseVersion');

const releasePrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/`;
const digestFragment = /#sha256=([0-9a-f]{64})$/;
const refs = new Set();
const digests = new Set();
const assetDigests = new Set(platforms.map((platform) => policy.assetSha256?.[platform]).filter((value) => typeof value === 'string'));
const coreEvidenceDigests = new Set(Object.entries(policy.evidence)
  .filter(([name]) => !Object.values(sbomKeys).includes(name))
  .map(([, value]) => typeof value === 'string' ? value.match(digestFragment)?.[1] : null)
  .filter(Boolean));

for (const platform of platforms) {
  const asset = policy.assets?.[platform];
  const assetDigest = policy.assetSha256?.[platform];
  if (typeof asset !== 'string' || !asset.startsWith(releasePrefix)) throw new Error(`${platform} SBOM evidence requires canonical promoted asset`);
  if (typeof assetDigest !== 'string' || !/^[0-9a-f]{64}$/.test(assetDigest)) throw new Error(`${platform} SBOM evidence requires promoted artifact digest`);
  const assetName = asset.slice(releasePrefix.length);
  const expectedSbomName = `${assetName}.sbom.cdx.json`;
  const value = policy.evidence[sbomKeys[platform]];
  if (typeof value !== 'string') throw new Error(`promotion requires ${platform} SBOM evidence`);
  const match = value.match(digestFragment);
  if (!match) throw new Error(`${platform} SBOM evidence must include exact sha256 digest binding`);
  const reference = value.slice(0, value.length - match[0].length);
  if (reference !== `${releasePrefix}${expectedSbomName}`) throw new Error(`${platform} SBOM evidence must use exact promoted-artifact SBOM asset name`);
  if (refs.has(reference)) throw new Error('SBOM evidence references must be distinct per platform');
  if (digests.has(match[1])) throw new Error('SBOM evidence sha256 identities must be distinct per platform');
  if (assetDigests.has(match[1])) throw new Error(`${platform} SBOM evidence must not alias promoted artifact bytes`);
  if (coreEvidenceDigests.has(match[1])) throw new Error(`${platform} SBOM evidence must not alias another evidence role`);
  refs.add(reference);
  digests.add(match[1]);
}

console.log('miner release per-platform SBOM evidence is fail-closed and promotion-bound');
