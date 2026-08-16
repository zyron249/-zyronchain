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
for (const field of ['releaseEligible','platformSigningVerified','provenanceVerified','checksumsVerified','immutableReleaseVerified','publicationAllowed','publicMiningActivated']) {
  if (policy[field] !== true) throw new Error(`promotion requires ${field}=true`);
}
for (const [name, value] of Object.entries(policy.evidence)) {
  if (typeof value !== 'string' || value.trim().length < 8) throw new Error(`promotion requires reviewable ${name} evidence`);
}
console.log('miner release promotion policy is fully evidenced');
