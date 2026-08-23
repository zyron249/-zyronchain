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
const requiredTopLevelFields = [
  'schemaVersion',
  'releaseVersion',
  'sourceCommit',
  ...requiredBooleanFields,
  'assets',
  'assetSha256',
  'evidence'
];
const topLevelKeys = Object.keys(policy);
if (topLevelKeys.length !== requiredTopLevelFields.length ||
    [...topLevelKeys].sort().join(',') !== [...requiredTopLevelFields].sort().join(',')) {
  throw new Error('promotion policy must contain exactly the canonical schema-v2 top-level fields');
}
for (const field of requiredBooleanFields) {
  if (typeof policy[field] !== 'boolean') throw new Error(`${field} must be boolean`);
}
if (policy.schemaVersion !== 2) throw new Error('unsupported miner release promotion schema');
if (!policy.assets || typeof policy.assets !== 'object' || Array.isArray(policy.assets)) throw new Error('assets object required');
if (!policy.assetSha256 || typeof policy.assetSha256 !== 'object' || Array.isArray(policy.assetSha256)) throw new Error('assetSha256 object required');
if (!policy.evidence || typeof policy.evidence !== 'object' || Array.isArray(policy.evidence)) throw new Error('evidence object required');

const requiredPlatforms = ['windows', 'macos', 'linux'];
function requireExactPlatformKeys(value, label) {
  const keys = Object.keys(value);
  if (keys.length !== requiredPlatforms.length ||
      [...keys].sort().join(',') !== [...requiredPlatforms].sort().join(',')) {
    throw new Error(`${label} must contain exactly windows, macos and linux`);
  }
}
requireExactPlatformKeys(policy.assets, 'assets');
requireExactPlatformKeys(policy.assetSha256, 'assetSha256');

const assetEntries = requiredPlatforms.map((platform) => [platform, policy.assets[platform]]);
for (const [platform, asset] of assetEntries) {
  if (asset !== null && (typeof asset !== 'string' || !/^https:\/\/github\.com\/zyron249\/-zyronchain\/releases\/download\/[^/]+\/ZyronMiner-[A-Za-z0-9._-]+$/.test(asset))) {
    throw new Error(`untrusted ${platform} release asset`);
  }
}
const digestEntries = requiredPlatforms.map((platform) => [platform, policy.assetSha256[platform]]);
for (const [platform, digest] of digestEntries) {
  if (digest !== null && (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))) {
    throw new Error(`invalid ${platform} asset sha256`);
  }
}

const requiredEvidence = [
  'windowsSigning',
  'macosSigningOrNotarization',
  'provenance',
  'checksums',
  'immutableRelease',
  'publicMiningActivation'
];
const evidenceKeys = Object.keys(policy.evidence);
if (evidenceKeys.length !== requiredEvidence.length ||
    [...evidenceKeys].sort().join(',') !== [...requiredEvidence].sort().join(',')) {
  throw new Error('evidence must contain exactly the canonical promotion evidence keys');
}
const evidenceEntries = requiredEvidence.map((name) => [name, policy.evidence[name]]);

const anyAsset = assetEntries.some(([, asset]) => asset !== null);
const allAssets = assetEntries.every(([, asset]) => asset !== null);
const anyDigest = digestEntries.some(([, digest]) => digest !== null);
const allDigests = digestEntries.every(([, digest]) => typeof digest === 'string');
const activationRequested = requiredBooleanFields.some((field) => policy[field] === true) || anyAsset || anyDigest;

if (!activationRequested) {
  if (policy.releaseVersion !== null || policy.sourceCommit !== null) {
    throw new Error('inactive policy must not pin a publishable release identity');
  }
  for (const [name, value] of evidenceEntries) {
    if (value !== null) throw new Error(`inactive policy must not carry ${name} evidence`);
  }
  console.log('miner release promotion remains fail-closed');
  process.exit(0);
}

if (!/^[0-9a-f]{40}$/.test(policy.sourceCommit || '')) throw new Error('promotion requires exact sourceCommit');
if (!/^miner-v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(policy.releaseVersion || '')) throw new Error('promotion requires versioned miner release tag');
if (!allAssets) throw new Error('promotion requires Windows, macOS and Linux assets');
if (!allDigests) throw new Error('promotion requires Windows, macOS and Linux asset sha256 digests');

const distinctAssets = new Set(assetEntries.map(([, asset]) => asset));
if (distinctAssets.size !== requiredPlatforms.length) throw new Error('promotion requires distinct platform asset URLs');
for (const [platform, asset] of assetEntries) {
  const basename = asset.slice(asset.lastIndexOf('/') + 1).toLowerCase();
  if (!basename.includes(`-${platform}-`)) {
    throw new Error(`${platform} asset filename must contain canonical -${platform}- marker`);
  }
}

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
const evidenceReferences = [];
function evidenceRoleMatches(name, reference) {
  const exactCommitPath = reference.startsWith(exactBlobPrefix)
    ? reference.slice(exactBlobPrefix.length)
    : null;
  const exactReleaseAsset = reference.startsWith(releaseAssetPrefix)
    ? reference.slice(releaseAssetPrefix.length)
    : null;

  if (name === 'windowsSigning') {
    return exactCommitPath !== null && /^evidence\/windows-(?:signing|signature)\.json$/.test(exactCommitPath);
  }
  if (name === 'macosSigningOrNotarization') {
    return exactCommitPath !== null && /^evidence\/macos-(?:signing|notarization)\.json$/.test(exactCommitPath);
  }
  if (name === 'provenance') {
    return (exactCommitPath !== null && /^evidence\/(?:provenance|attestation)\.json$/.test(exactCommitPath)) ||
      (exactReleaseAsset !== null && /^(?:provenance|attestation)\.json$/.test(exactReleaseAsset));
  }
  if (name === 'checksums') {
    return exactReleaseAsset !== null && /^(?:SHA256SUMS|checksums\.txt)$/.test(exactReleaseAsset);
  }
  if (name === 'immutableRelease') {
    return reference === exactReleaseTag ||
      (exactCommitPath !== null && exactCommitPath === 'evidence/immutable-release.json');
  }
  if (name === 'publicMiningActivation') {
    return exactCommitPath !== null && /^evidence\/public-mining-(?:activation|authorization)\.json$/.test(exactCommitPath);
  }
  return false;
}
for (const [name, value] of evidenceEntries) {
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
  if (!evidenceRoleMatches(name, reference)) throw new Error(`${name} evidence must use its canonical security-role path`);
  evidenceReferences.push([name, reference]);
}

const distinctEvidenceReferences = new Set(evidenceReferences.map(([, reference]) => reference));
if (distinctEvidenceReferences.size !== requiredEvidence.length) {
  throw new Error('promotion requires distinct underlying references for all canonical evidence roles');
}

console.log('miner release promotion policy is fully evidenced');