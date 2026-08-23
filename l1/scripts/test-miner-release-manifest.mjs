#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectReleaseFiles, generateMinerSha256Sums } from './generate-miner-sha256sums.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-manifest-'));
try {
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'b.txt'), 'bravo');
  fs.writeFileSync(path.join(root, 'nested', 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), 'stale manifest must be excluded');

  const manifest = generateMinerSha256Sums(root);
  const expected = [
    [path.join(root, 'b.txt'), 'bravo'],
    [path.join(root, 'nested', 'a.txt'), 'alpha']
  ].sort(([a], [b]) => a.localeCompare(b)).map(([file, contents]) => {
    const digest = crypto.createHash('sha256').update(contents).digest('hex');
    return `${digest}  ${path.relative(process.cwd(), file).replaceAll('\\', '/')}`;
  }).join('\n') + '\n';
  assert.equal(manifest, expected, 'manifest must deterministically hash every regular file except itself');

  const fakeDirent = {
    name: 'unsupported-entry',
    isDirectory: () => false,
    isFile: () => false
  };
  assert.throws(
    () => collectReleaseFiles(root, { readdirSync: () => [fakeDirent] }),
    /unsupported non-regular miner release entry/,
    'non-regular entries must fail closed'
  );

  if (process.platform !== 'win32') {
    const link = path.join(root, 'linked-file');
    fs.symlinkSync(path.join(root, 'b.txt'), link);
    assert.throws(
      () => collectReleaseFiles(root),
      /unsupported non-regular miner release entry: linked-file/,
      'symlinks must not be followed or silently omitted'
    );
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner release manifest regressions passed');
