#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateMinerSha256Sums } from './generate-miner-sha256sums.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-manifest-stale-temp-'));
try {
  fs.writeFileSync(path.join(root, 'artifact.bin'), 'canonical-artifact');

  const staleFile = path.join(root, '.SHA256SUMS.123.deadbeef.tmp');
  fs.writeFileSync(staleFile, 'stale-publication-bytes');
  assert.throws(
    () => generateMinerSha256Sums(root),
    /stale miner release SHA256SUMS publication temporary entry/,
    'stale manifest publication files must fail closed rather than enter release identity'
  );
  assert.equal(fs.readFileSync(staleFile, 'utf8'), 'stale-publication-bytes', 'stale publication evidence must not be silently deleted');
  assert.equal(fs.existsSync(path.join(root, 'SHA256SUMS')), false, 'failed stale-temp admission must not publish a manifest');
  fs.rmSync(staleFile);

  const staleDirectory = path.join(root, '.SHA256SUMS.456.cafebabe.tmp');
  fs.mkdirSync(staleDirectory);
  fs.writeFileSync(path.join(staleDirectory, 'payload'), 'stale-directory-state');
  assert.throws(
    () => generateMinerSha256Sums(root),
    /stale miner release SHA256SUMS publication temporary entry/,
    'stale manifest publication directories must fail closed before traversal'
  );
  assert.equal(fs.readFileSync(path.join(staleDirectory, 'payload'), 'utf8'), 'stale-directory-state', 'stale directory evidence must remain visible for cleanup/review');
  assert.equal(fs.existsSync(path.join(root, 'SHA256SUMS')), false, 'stale directory admission failure must not publish a manifest');
  fs.rmSync(staleDirectory, { recursive: true });

  const manifest = generateMinerSha256Sums(root);
  assert.match(manifest, /  artifact\.bin\n$/, 'a clean release tree must still generate the canonical manifest');
  assert.equal(fs.existsSync(path.join(root, 'SHA256SUMS')), true, 'clean release tree must publish SHA256SUMS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner release stale SHA256SUMS temp regressions passed');
