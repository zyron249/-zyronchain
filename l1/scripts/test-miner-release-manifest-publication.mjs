#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateMinerSha256Sums } from './generate-miner-sha256sums.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-manifest-publish-'));
try {
  const release = path.join(root, 'release');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(release, 'payload.bin'), 'payload');
  fs.writeFileSync(outside, 'sentinel');

  let tempOpenFlags;
  let injected = false;
  const fsOps = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (file, flags, mode) => {
          if (path.basename(String(file)).startsWith('.SHA256SUMS.')) tempOpenFlags = flags;
          return fs.openSync(file, flags, mode);
        };
      }
      if (property === 'renameSync') {
        return (source, destination) => {
          if (!injected && path.basename(String(destination)) === 'SHA256SUMS' && process.platform !== 'win32') {
            injected = true;
            fs.symlinkSync(outside, destination);
          }
          return fs.renameSync(source, destination);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const manifest = generateMinerSha256Sums(release, fsOps);
  assert.match(manifest, /^[0-9a-f]{64}  payload\.bin\n$/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel', 'raced manifest symlink must never receive manifest bytes');
  assert.equal(fs.lstatSync(path.join(release, 'SHA256SUMS')).isFile(), true, 'atomic rename must replace the raced leaf itself with a regular manifest');
  assert.equal(fs.readFileSync(path.join(release, 'SHA256SUMS'), 'utf8'), manifest);
  if (process.platform !== 'win32') assert.equal(injected, true, 'regression must exercise the final-leaf replacement boundary');

  assert.equal((tempOpenFlags & fs.constants.O_CREAT) !== 0, true);
  assert.equal((tempOpenFlags & fs.constants.O_EXCL) !== 0, true);
  assert.equal((tempOpenFlags & fs.constants.O_WRONLY) !== 0, true);
  if (fs.constants.O_NOFOLLOW !== undefined) {
    assert.equal((tempOpenFlags & fs.constants.O_NOFOLLOW) !== 0, true);
  }

  const rerun = generateMinerSha256Sums(release);
  assert.equal(rerun, manifest, 'atomic publication must preserve deterministic regeneration over an existing regular SHA256SUMS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner release manifest publication race regression passed');
