#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateMinerSha256Sums } from './generate-miner-sha256sums.mjs';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-manifest-root-relative-'));
const originalCwd = process.cwd();
try {
  const releaseRoot = path.join(sandbox, 'candidate');
  const cwdA = path.join(sandbox, 'cwd-a');
  const cwdB = path.join(sandbox, 'cwd-b', 'nested');
  fs.mkdirSync(path.join(releaseRoot, 'nested'), { recursive: true });
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, 'b.txt'), 'bravo');
  fs.writeFileSync(path.join(releaseRoot, 'nested', 'a.txt'), 'alpha');

  process.chdir(cwdA);
  const manifestA = generateMinerSha256Sums(releaseRoot);
  process.chdir(cwdB);
  const manifestB = generateMinerSha256Sums(releaseRoot);

  assert.equal(manifestB, manifestA, 'checksum manifest bytes must not depend on caller cwd');

  const entries = [
    ['b.txt', 'bravo'],
    ['nested/a.txt', 'alpha']
  ].sort(([a], [b]) => a.localeCompare(b));
  const expected = entries.map(([relative, contents]) => {
    const digest = crypto.createHash('sha256').update(contents).digest('hex');
    return `${digest}  ${relative}`;
  }).join('\n') + '\n';

  assert.equal(manifestA, expected, 'checksum paths must be canonical release-root-relative paths');
  assert.doesNotMatch(manifestA, /(^|\s)\.\.(?:\/|\\)/m, 'checksum manifest must not serialize parent-directory segments');
  assert.equal(manifestA.includes(path.basename(releaseRoot) + '/'), false, 'checksum manifest must not leak the release-root directory name as a cwd-dependent prefix');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('miner release root-relative manifest regression passed');
