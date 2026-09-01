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
const platforms = ['windows', 'macos', 'linux'];
const activationRequested = ['publicMiningActivated','releaseEligible','platformSigningVerified','provenanceVerified','checksumsVerified','immutableReleaseVerified','publicationAllowed','sbomVerified']
  .some((field) => policy[field] === true) || platforms.some((p) => policy.assets?.[p] !== null) || platforms.some((p) => policy.assetSha256?.[p] !== null);
if (!activationRequested) {
  console.log('public-mining activation subject binding remains fail-closed');
  process.exit(0);
}

const subjects = platforms.map((platform) => {
  const asset = policy.assets?.[platform];
  const sha256 = policy.assetSha256?.[platform];
  if (typeof asset !== 'string' || typeof sha256 !== 'string') throw new Error(`missing ${platform} public-mining activation subject identity`);
  const name = asset.slice(asset.lastIndexOf('/') + 1);
  if (!name || name.includes('/') || name.includes('\\')) throw new Error(`invalid ${platform} public-mining activation subject filename`);
  return { platform, name, sha256 };
});
if (new Set(subjects.map((s) => s.name)).size !== platforms.length) throw new Error('public-mining activation subjects must use distinct artifact filenames');
if (new Set(subjects.map((s) => s.sha256)).size !== platforms.length) throw new Error('public-mining activation subjects must use distinct artifact digests');

const evidence = policy.evidence?.publicMiningActivation;
if (typeof evidence !== 'string') throw new Error('promotion requires publicMiningActivation evidence');
const digestMatch = evidence.match(/#sha256=([0-9a-f]{64})$/);
if (!digestMatch) throw new Error('publicMiningActivation evidence must include exact sha256 digest binding');
const canonicalDocument = `${JSON.stringify({ schemaVersion: 1, releaseVersion: policy.releaseVersion, sourceCommit: policy.sourceCommit, subjects })}\n`;
const expected = createHash('sha256').update(canonicalDocument, 'utf8').digest('hex');
if (digestMatch[1] !== expected) throw new Error('publicMiningActivation evidence digest does not bind the exact promoted release identity and platform subjects');
console.log('public-mining activation evidence binds exact release identity and all promoted platform subjects');
