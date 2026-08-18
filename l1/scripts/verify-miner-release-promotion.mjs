#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || path.resolve(process.cwd(), '../docs/miner-release-promotion.json');
const policy = JSON.parse(fs.readFileSync(file, 'utf8'));

const requiredBooleanFields = [
  'publicMiningActivated',
  'releaseEligible',
  'platformSigningVerified',
  'provenanceVerified',
  'checksumsVerified',
  'immutableReleaseVerified',
  'publicationAllowed'
];
for (const field of requiredBooleanFields) {
  if (typeof policy[field] !== 'boolean') throw new Error(`${field} must be boolean`);
}
if (policy.schemaVersion !== 1) throw new Error('unsupported miner release promotion schema');
if (!policy.assets || typeof policy.assets !== 'object') throw new Error('assets object required');
if (!policy.evidence || typeof policy.evidence !== 'object') throw new Error('evidence object required');

const assetEntries = Object.entries(policy.assets);
for (const [platform, asset] of assetEntries) {
  if (!['windows', 'macos', 'linux'].includes(platform)) throw new Error(`unexpected platform ${platform}`);
  if (asset !== null && (typeof asset !== 'string' || !/^https:\/\/github\.com\/zyron249\/-zyronchain\/releases\/download\/[^/]+\/ZyronMiner-[A-Za-z0-9._-]+$/.test(asset))) {
    throw new Error(`untrusted ${platform} release asset`);
  }
}

const anyAsset = assetEntries.some(([, asset]) => asset !== null);
const allAssets = assetEntries.every(([, asset]) => asset !== null);
const activationRequested = policy.publicMiningActivated || policy.releaseEligible || policy.publicationAllowed || anyAsset;

if (!activationRequested) {
  if (policy.releaseVersion !== null || policy.sourceCommit !== null) {
    throw new Error('inactive policy must not pin a publishable release identity');
  }
  for (const [name, value] of Object.entries(policy.evidence)) {
    if (value !== null) throw new Error(`inactive policy must not carry ${name} evidence`);
  }
  console.log('miner release promotion remains fail-closed');
  process.exit(0);
}

if (!/^[0-9a-f]{40}$/.test(policy.sourceCommit || '')) throw new Error('promotion requires exact sourceCommit');
if (!/^miner-v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(policy.releaseVersion || '')) throw new Error('promotion requires versioned miner release tag');
if (!allAssets) throw new Error('promotion requires Windows, macOS and Linux assets');

const releaseAssetPrefix = `https://github.com/zyron249/-zyronchain/releases/download/${policy.releaseVersion}/`;
for (const [platform, asset] of assetEntries) {
  if (!asset.startsWith(releaseAssetPrefix)) throw new Error(`${platform} asset must be bound to releaseVersion ${policy.releaseVersion}`);
}

for (const field of ['releaseEligible','platformSigningVerified','provenanceVerified','checksumsVerified','immutableReleaseVerified','publicationAllowed','publicMiningActivated']) {
  if (policy[field] !== true) throw new Error(`promotion requires ${field}=true`);
}

const digestFragment = /#sha256=([0-9a-f]{64})$/;
const exactBlobPrefix = `https://github.com/zyron249/-zyronchain/blob/${policy.sourceCommit}/`;
const exactReleaseTag = `https://github.com/zyron249/-zyronchain/releases/tag/${policy.releaseVersion}`;
for (const [name, value] of Object.entries(policy.evidence)) {
  if (typeof value !== 'string') throw new Error(`promotion requires reviewable ${name} evidence`);
  const digestMatch = value.match(digestFragment);
  if (!digestMatch) throw new Error(`${name} evidence must include exact sha256 digest binding`);
  const reference = value.slice(0, value.length - digestMatch[0].length);
  const exactCommitEvidence = reference.startsWith(exactBlobPrefix);
  const exactReleaseAssetEvidence = reference.startsWith(releaseAssetPrefix);
  const exactReleasePageEvidence = reference === exactReleaseTag;
  if (!exactCommitEvidence && !exactReleaseAssetEvidence && !exactReleasePageEvidence) {
    throw new Error(`${name} evidence must bind to exact sourceCommit or releaseVersion`);
  }
  if (/\/blob\/(?:main|master|HEAD)\//.test(reference)) throw new Error(`${name} evidence must not use mutable branch refs`);
}

console.log('miner release promotion policy is fully evidenced');
