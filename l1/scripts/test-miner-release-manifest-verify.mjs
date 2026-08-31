#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateMinerSha256Sums, verifyMinerSha256Sums } from './generate-miner-sha256sums.mjs';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-sha256-verify-'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(root, 'nested', 'b.txt'), 'bravo');
  generateMinerSha256Sums(root);
  return root;
}

function manifest(root) {
  return fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8');
}

function writeManifest(root, value) {
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), value, 'utf8');
}

{
  const root = fixture();
  try {
    assert.equal(verifyMinerSha256Sums(root), manifest(root), 'freshly generated manifest must verify');

    fs.writeFileSync(path.join(root, 'a.txt'), 'tampered');
    assert.throws(() => verifyMinerSha256Sums(root), /digest mismatch: a\.txt/, 'post-generation payload tamper must fail closed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'extra.txt'), 'extra');
    assert.throws(() => verifyMinerSha256Sums(root), /file set does not match release root/, 'extra release file must invalidate manifest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    fs.rmSync(path.join(root, 'nested', 'b.txt'));
    assert.throws(() => verifyMinerSha256Sums(root), /file set does not match release root/, 'missing release file must invalidate manifest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    const line = `${digest('alpha')}  a.txt`;
    writeManifest(root, `${line}\n${line}\n`);
    assert.throws(() => verifyMinerSha256Sums(root), /duplicate path: a\.txt/, 'duplicate manifest paths must fail closed');

    writeManifest(root, `${digest('alpha')} a.txt\n`);
    assert.throws(() => verifyMinerSha256Sums(root), /malformed record/, 'single-space checksum syntax must fail closed');

    writeManifest(root, `${digest('alpha')}  ..\/a.txt\n`);
    assert.throws(() => verifyMinerSha256Sums(root), /non-canonical path|non-canonical release path|file set or ordering/, 'path traversal syntax must fail closed');

    writeManifest(root, `${digest('alpha')}  nested\\b.txt\n`);
    assert.throws(() => verifyMinerSha256Sums(root), /non-canonical path/, 'ambiguous backslash paths must fail closed');

    writeManifest(root, `${digest('alpha')}  a.txt`);
    assert.throws(() => verifyMinerSha256Sums(root), /must end with exactly one canonical newline-delimited record set/, 'unterminated manifest must fail closed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.platform !== 'win32') {
  const root = fixture();
  try {
    const target = path.join(root, 'manifest-target');
    fs.renameSync(path.join(root, 'SHA256SUMS'), target);
    fs.symlinkSync(target, path.join(root, 'SHA256SUMS'));
    assert.throws(() => verifyMinerSha256Sums(root), /must be a regular file/, 'symlinked SHA256SUMS leaf must fail closed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('miner release SHA256SUMS verification regressions passed');
