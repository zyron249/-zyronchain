#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCandidateIntegrity, verifyCandidateIntegrity, writeCandidateIntegrity } from './miner-candidate-integrity.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-candidate-integrity-'));
try {
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'b.txt'), 'bravo');
  fs.writeFileSync(path.join(root, 'nested', 'a.txt'), 'alpha');
  const metadata = { version: '0.1.0', platform: 'linux', arch: 'x64', sourceCommit: '0123456789abcdef0123456789abcdef01234567' };

  const first = buildCandidateIntegrity(root, metadata);
  const second = buildCandidateIntegrity(root, metadata);
  assert.deepEqual(first, second, 'candidate integrity inventory must be deterministic');
  assert.deepEqual(first.files.map((entry) => entry.path), ['b.txt', 'nested/a.txt'], 'candidate paths must be sorted and root-relative');

  const written = writeCandidateIntegrity(root, metadata);
  assert.deepEqual(written, first, 'published manifest must match deterministic inventory');
  assert.deepEqual(verifyCandidateIntegrity(root), first, 'fresh candidate must verify');

  fs.writeFileSync(path.join(root, 'b.txt'), 'tampered');
  assert.throws(() => verifyCandidateIntegrity(root), /candidate integrity verification failed/, 'post-manifest tampering must fail closed');

  fs.writeFileSync(path.join(root, 'b.txt'), 'bravo');
  fs.rmSync(path.join(root, 'candidate-integrity.json'));
  if (process.platform !== 'win32') {
    fs.symlinkSync('b.txt', path.join(root, 'link'));
    assert.throws(() => buildCandidateIntegrity(root, metadata), /rejects symlink/, 'candidate symlinks must fail closed');
    fs.rmSync(path.join(root, 'link'));
  }

  assert.throws(
    () => buildCandidateIntegrity(root, { ...metadata, sourceCommit: 'not-a-commit' }),
    /source commit/,
    'ambiguous source identity must fail closed'
  );
  assert.throws(
    () => buildCandidateIntegrity(root, { ...metadata, platform: 'win32' }),
    /audited POSIX platforms/,
    'unaudited platforms must remain fail closed'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner candidate integrity regressions passed');
