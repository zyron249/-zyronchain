#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateMinerSha256Sums } from './generate-miner-sha256sums.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-manifest-snapshot-'));
try {
  const stableRoot = path.join(root, 'stable');
  fs.mkdirSync(stableRoot);
  fs.writeFileSync(path.join(stableRoot, 'stable.bin'), 'stable-bytes');
  assert.doesNotThrow(() => generateMinerSha256Sums(stableRoot), 'stable release files must remain hashable');

  const replacementRoot = path.join(root, 'replacement');
  const replacementFile = path.join(replacementRoot, 'artifact.bin');
  fs.mkdirSync(replacementRoot);
  fs.writeFileSync(replacementFile, 'validated-artifact');
  const canonicalReplacementFile = fs.realpathSync(replacementFile);
  let replacementInjected = false;
  const replacementFsOps = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, ...args) => {
          if (!replacementInjected && path.resolve(candidate) === path.resolve(canonicalReplacementFile)) {
            replacementInjected = true;
            fs.rmSync(replacementFile);
            fs.writeFileSync(replacementFile, 'raced-replacement-artifact');
          }
          return fs.openSync(candidate, ...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => generateMinerSha256Sums(replacementRoot, replacementFsOps),
    /miner release manifest input snapshot changed before hashing: artifact\.bin/,
    'pathname replacement between validation and descriptor open must fail closed'
  );
  assert.equal(replacementInjected, true, 'replacement regression must exercise the descriptor-open boundary');
  assert.equal(fs.existsSync(path.join(replacementRoot, 'SHA256SUMS')), false, 'raced replacement must not publish a checksum manifest');

  const mutationRoot = path.join(root, 'mutation');
  const mutationFile = path.join(mutationRoot, 'artifact.bin');
  fs.mkdirSync(mutationRoot);
  fs.writeFileSync(mutationFile, 'x'.repeat(192 * 1024));
  let mutationInjected = false;
  const mutationFsOps = new Proxy(fs, {
    get(target, property) {
      if (property === 'readSync') {
        return (fd, buffer, offset, length, position) => {
          const bytesRead = fs.readSync(fd, buffer, offset, length, position);
          if (!mutationInjected && bytesRead > 0) {
            mutationInjected = true;
            fs.appendFileSync(mutationFile, 'mutation-during-hash');
          }
          return bytesRead;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => generateMinerSha256Sums(mutationRoot, mutationFsOps),
    /miner release manifest input mutated during hashing: artifact\.bin/,
    'in-place mutation during descriptor hashing must fail closed'
  );
  assert.equal(mutationInjected, true, 'mutation regression must exercise the descriptor-read boundary');
  assert.equal(fs.existsSync(path.join(mutationRoot, 'SHA256SUMS')), false, 'mutated input must not publish a checksum manifest');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner release manifest snapshot regressions passed');
