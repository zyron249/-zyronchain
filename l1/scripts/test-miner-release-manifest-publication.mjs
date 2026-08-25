#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateMinerSha256Sums } from './generate-miner-sha256sums.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-manifest-publish-'));
const release = path.join(root, 'release');
const outside = path.join(root, 'outside.txt');
fs.mkdirSync(release);
fs.writeFileSync(path.join(release, 'payload.bin'), 'payload');
fs.writeFileSync(outside, 'sentinel');

let manifestOpenFlags;
const fsOps = new Proxy(fs, {
  get(target, property) {
    if (property !== 'openSync') return Reflect.get(target, property);
    return (file, flags, mode) => {
      if (path.basename(String(file)) === 'SHA256SUMS') {
        manifestOpenFlags = flags;
        if (process.platform !== 'win32') fs.symlinkSync(outside, file);
      }
      return fs.openSync(file, flags, mode);
    };
  },
});

if (process.platform !== 'win32') {
  assert.throws(
    () => generateMinerSha256Sums(release, fsOps),
    /EEXIST|ELOOP|exist|symbolic/i,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
  assert.equal(fs.lstatSync(path.join(release, 'SHA256SUMS')).isSymbolicLink(), true);
} else {
  const occupied = path.join(release, 'SHA256SUMS');
  fs.writeFileSync(occupied, 'occupied');
  assert.throws(() => generateMinerSha256Sums(release), /EEXIST|exist/i);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'occupied');
}

assert.equal((manifestOpenFlags & fs.constants.O_CREAT) !== 0, true);
assert.equal((manifestOpenFlags & fs.constants.O_EXCL) !== 0, true);
assert.equal((manifestOpenFlags & fs.constants.O_WRONLY) !== 0, true);
if (fs.constants.O_NOFOLLOW !== undefined) {
  assert.equal((manifestOpenFlags & fs.constants.O_NOFOLLOW) !== 0, true);
}

console.log('miner release manifest publication race regression passed');
