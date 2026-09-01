#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyFile = process.argv[2] || path.resolve(process.cwd(), '../docs/miner-release-promotion.json');
const baselineVerifier = path.join(here, 'verify-miner-release-promotion.mjs');

const baseline = spawnSync(process.execPath, [baselineVerifier, policyFile], { encoding: 'utf8' });
if (baseline.status !== 0) {
  process.stderr.write(baseline.stderr || baseline.stdout || 'baseline miner release promotion verification failed\n');
  process.exit(baseline.status ?? 1);
}

const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
const requiredPlatforms = ['windows', 'macos', 'linux'];
const activationRequested = [
  'publicMiningActivated',
  'releaseEligible',
  'platformSigningVerified',
  'provenanceVerified',
  'checksumsVerified',
  'immutableReleaseVerified',
  'publicationAllowed'
].some((field) => policy[field] === true) ||
  requiredPlatforms.some((platform) => policy.assets?.[platform] !== null) ||
  requiredPlatforms.some((platform) => policy.assetSha256?.[platform] !== null);

if (!activationRequested) {
  console.log('miner release checksum subject binding remains fail-closed');
  process.exit(0);
}

function canonicalSubjects() {
  return requiredPlatforms.map((platform) => {
    const asset = policy.assets[platform];
    const sha256 = policy.assetSha256[platform];
    if (typeof asset !== 'string' || typeof sha256 !== 'string') {
      throw new Error(`missing ${platform} checksum subject identity`);
    }
    const name = asset.slice(asset.lastIndexOf('/') + 1);
    if (!name || name.includes('/') || name.includes('\\')) {
      throw new Error(`invalid ${platform} checksum subject filename`);
    }
    return { platform, name, sha256 };
  });
}

const subjects = canonicalSubjects();
if (new Set(subjects.map((subject) => subject.name)).size !== requiredPlatforms.length) {
  throw new Error('checksum subjects must use distinct canonical artifact filenames');
}
if (new Set(subjects.map((subject) => subject.sha256)).size !== requiredPlatforms.length) {
  throw new Error('checksum subjects must use distinct platform artifact digests');
}

const checksums = policy.evidence?.checksums;
if (typeof checksums !== 'string') throw new Error('promotion requires checksum evidence');
const digestMatch = checksums.match(/#sha256=([0-9a-f]{64})$/);
if (!digestMatch) throw new Error('checksum evidence must include exact sha256 digest binding');

const canonicalDocument = `${JSON.stringify({
  schemaVersion: 1,
  releaseVersion: policy.releaseVersion,
  sourceCommit: policy.sourceCommit,
  subjects
})}\n`;
const expectedDigest = createHash('sha256').update(canonicalDocument, 'utf8').digest('hex');
if (digestMatch[1] !== expectedDigest) {
  throw new Error('checksum evidence digest does not bind the exact Windows, macOS and Linux promoted subjects');
}

console.log('miner release checksum evidence binds all promoted platform subjects');
