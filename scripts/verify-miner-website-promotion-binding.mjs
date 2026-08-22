#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const promotion = JSON.parse(readFileSync('docs/miner-release-promotion.json', 'utf8'));
const app = readFileSync('website/app.js', 'utf8');

const requiredPlatforms = ['windows', 'macos', 'linux'];
const trustedAsset = /^https:\/\/github\.com\/zyron249\/-zyronchain\/releases\/download\/([^/]+)\/ZyronMiner-[A-Za-z0-9._-]+$/;
const trustedSha256 = /^[0-9a-f]{64}$/;

function extractLiteral(name) {
  const match = app.match(new RegExp(`${name}:\\s*(true|false|null|'[^']*'|\"[^\"]*\")`));
  if (!match) throw new Error(`website miner distribution missing literal ${name}`);
  const value = match[1];
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  return value.slice(1, -1);
}

function extractPlatformMap(name) {
  const match = app.match(new RegExp(`${name}:\\s*Object\\.freeze\\(\\{\\s*windows:\\s*([^,]+),\\s*macos:\\s*([^,]+),\\s*linux:\\s*([^}]+)\\}\\)`, 's'));
  if (!match) throw new Error(`website miner distribution ${name} literal missing`);
  const parse = (raw) => {
    const value = raw.trim();
    if (value === 'null') return null;
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) return value.slice(1, -1);
    throw new Error(`website miner ${name} entry must be a static string/null literal: ${value}`);
  };
  return { windows: parse(match[1]), macos: parse(match[2]), linux: parse(match[3]) };
}

const website = {
  enabled: extractLiteral('enabled'),
  publicMiningActivated: extractLiteral('publicMiningActivated'),
  version: extractLiteral('version'),
  assets: extractPlatformMap('assets'),
  assetSha256: extractPlatformMap('assetSha256')
};

const promotionLive = promotion.publicationAllowed === true;
const activationLive = promotion.publicMiningActivated === true;

if (!promotionLive || !activationLive) {
  if (website.enabled !== false || website.publicMiningActivated !== false || website.version !== null) {
    throw new Error('website miner distribution must remain fail-closed until canonical publication and public mining are both allowed');
  }
  for (const platform of requiredPlatforms) {
    if (website.assets[platform] !== null) throw new Error(`website ${platform} asset must remain null while promotion is gated`);
    if (website.assetSha256[platform] !== null) throw new Error(`website ${platform} digest must remain null while promotion is gated`);
  }
  console.log('Miner website promotion binding: fail-closed URL+digest state verified.');
  process.exit(0);
}

for (const flag of ['releaseEligible', 'platformSigningVerified', 'provenanceVerified', 'checksumsVerified', 'immutableReleaseVerified']) {
  if (promotion[flag] !== true) throw new Error(`promotion cannot be live without ${flag}=true`);
}
if (typeof promotion.releaseVersion !== 'string' || promotion.releaseVersion.length < 1) throw new Error('live promotion requires releaseVersion');
if (typeof promotion.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(promotion.sourceCommit)) throw new Error('live promotion requires exact 40-hex sourceCommit');
if (website.enabled !== true || website.publicMiningActivated !== true) throw new Error('live canonical promotion requires website activation to match');
if (website.version !== promotion.releaseVersion) throw new Error('website miner version does not match canonical promotion releaseVersion');

for (const platform of requiredPlatforms) {
  const canonical = promotion.assets?.[platform];
  const canonicalDigest = promotion.assetSha256?.[platform];
  const actual = website.assets[platform];
  const actualDigest = website.assetSha256[platform];
  if (typeof canonical !== 'string' || !trustedAsset.test(canonical)) throw new Error(`canonical ${platform} asset is not a trusted immutable GitHub Release URL`);
  if (typeof canonicalDigest !== 'string' || !trustedSha256.test(canonicalDigest)) throw new Error(`canonical ${platform} digest is not a lowercase SHA-256`);
  const releaseTag = canonical.match(trustedAsset)?.[1];
  if (releaseTag !== promotion.releaseVersion) throw new Error(`canonical ${platform} asset tag does not match releaseVersion`);
  if (actual !== canonical) throw new Error(`website ${platform} asset does not exactly match canonical promotion policy`);
  if (actualDigest !== canonicalDigest) throw new Error(`website ${platform} digest does not exactly match canonical promotion policy`);
}

if (!app.includes('Expected SHA-256: ${assetSha256}')) throw new Error('live website must surface the selected canonical SHA-256');
console.log('Miner website promotion binding: live canonical URL+digest promotion verified.');
