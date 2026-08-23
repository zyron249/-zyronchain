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
    fs.rmSync(link);

    const sourceTree = path.join(root, 'runtime-source');
    const copiedTree = path.join(root, 'runtime-candidate');
    fs.mkdirSync(path.join(sourceTree, '.bin'), { recursive: true });
    fs.writeFileSync(path.join(sourceTree, 'tool.js'), 'runtime-tool');
    fs.symlinkSync(path.join('..', 'tool.js'), path.join(sourceTree, '.bin', 'tool'));
    fs.cpSync(sourceTree, copiedTree, { recursive: true, dereference: true });
    assert.equal(fs.lstatSync(path.join(copiedTree, '.bin', 'tool')).isFile(), true, 'packaging-style dereference must materialize npm executable shims as regular files');
    assert.doesNotThrow(() => collectReleaseFiles(copiedTree), 'materialized runtime trees must be fully checksum-coverable');
  }

  const packageMinerSource = fs.readFileSync(path.resolve(process.cwd(), 'scripts/package-miner.mjs'), 'utf8');
  assert.match(
    packageMinerSource,
    /cp\(join\(root, 'node_modules'\), join\(bundle, 'node_modules'\), \{ recursive: true, dereference: true \}\)/,
    'canonical miner packaging must materialize npm runtime symlinks before checksum generation'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner release manifest regressions passed');
