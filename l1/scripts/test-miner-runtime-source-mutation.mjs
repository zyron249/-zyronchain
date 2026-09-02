#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyMinerRuntimeTree } from './copy-miner-runtime-tree.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-source-mutation-'));
try {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow) || noFollow === 0) {
    const unsupportedSource = path.join(root, 'unsupported-source');
    const unsupportedDestination = path.join(root, 'unsupported-candidate');
    fs.mkdirSync(unsupportedSource);
    fs.writeFileSync(path.join(unsupportedSource, 'tool.js'), 'validated');
    assert.throws(
      () => copyMinerRuntimeTree(unsupportedSource, unsupportedDestination),
      /miner runtime packaging requires O_NOFOLLOW support/,
      'platforms without O_NOFOLLOW must fail closed before materialization'
    );
    assert.equal(fs.existsSync(unsupportedDestination), false, 'unsupported platform must not create a candidate');
    console.log('miner runtime no-follow unsupported-platform regression passed');
    process.exit(0);
  }

  const symlinkRaceSourceRoot = path.join(root, 'symlink-race-source');
  const symlinkRaceSource = path.join(symlinkRaceSourceRoot, 'tool.js');
  const symlinkRaceTarget = path.join(symlinkRaceSourceRoot, 'alternate.js');
  const symlinkRaceDestination = path.join(root, 'symlink-race-candidate');
  fs.mkdirSync(symlinkRaceSourceRoot);
  fs.writeFileSync(symlinkRaceSource, 'validated');
  fs.writeFileSync(symlinkRaceTarget, 'attacker-controlled');
  const canonicalSymlinkRaceSource = fs.realpathSync(symlinkRaceSource);
  let symlinkRaceInjected = false;
  const symlinkRaceFsOps = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, ...args) => {
          if (!symlinkRaceInjected && path.resolve(candidate) === path.resolve(canonicalSymlinkRaceSource)) {
            symlinkRaceInjected = true;
            fs.unlinkSync(symlinkRaceSource);
            fs.symlinkSync(path.basename(symlinkRaceTarget), symlinkRaceSource);
          }
          return fs.openSync(candidate, ...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => copyMinerRuntimeTree(symlinkRaceSourceRoot, symlinkRaceDestination, symlinkRaceFsOps),
    (error) => error?.code === 'ELOOP' || /symbolic link|too many levels/i.test(String(error?.message)),
    'source replacement with a symlink immediately before open must fail at O_NOFOLLOW'
  );
  assert.equal(symlinkRaceInjected, true, 'symlink race regression must exercise the descriptor-open boundary');
  assert.equal(fs.existsSync(path.join(symlinkRaceDestination, 'tool.js')), false, 'symlink-race bytes must not enter the candidate');

  const preOpenSourceRoot = path.join(root, 'pre-open-source');
  const preOpenSource = path.join(preOpenSourceRoot, 'tool.js');
  const preOpenDestination = path.join(root, 'pre-open-candidate');
  fs.mkdirSync(preOpenSourceRoot);
  fs.writeFileSync(preOpenSource, 'validated');
  const canonicalPreOpenSource = fs.realpathSync(preOpenSource);
  let preOpenMutationInjected = false;
  const preOpenFsOps = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, ...args) => {
          if (!preOpenMutationInjected && path.resolve(candidate) === path.resolve(canonicalPreOpenSource)) {
            preOpenMutationInjected = true;
            fs.writeFileSync(preOpenSource, 'mutated-before-open-with-different-size');
          }
          return fs.openSync(candidate, ...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => copyMinerRuntimeTree(preOpenSourceRoot, preOpenDestination, preOpenFsOps),
    /miner runtime source snapshot changed before copy: tool\.js/,
    'in-place mutation between validation and descriptor open must fail closed'
  );
  assert.equal(preOpenMutationInjected, true, 'pre-open mutation regression must exercise the descriptor-open boundary');
  assert.equal(fs.existsSync(path.join(preOpenDestination, 'tool.js')), false, 'pre-open mutated bytes must not enter the candidate');

  const duringCopySourceRoot = path.join(root, 'during-copy-source');
  const duringCopySource = path.join(duringCopySourceRoot, 'large.js');
  const duringCopyDestination = path.join(root, 'during-copy-candidate');
  fs.mkdirSync(duringCopySourceRoot);
  fs.writeFileSync(duringCopySource, 'x'.repeat(192 * 1024));
  let duringCopyMutationInjected = false;
  const duringCopyFsOps = new Proxy(fs, {
    get(target, property) {
      if (property === 'readSync') {
        return (fd, buffer, offset, length, position) => {
          const bytesRead = fs.readSync(fd, buffer, offset, length, position);
          if (!duringCopyMutationInjected && bytesRead > 0) {
            duringCopyMutationInjected = true;
            fs.appendFileSync(duringCopySource, 'mutation-during-copy');
          }
          return bytesRead;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => copyMinerRuntimeTree(duringCopySourceRoot, duringCopyDestination, duringCopyFsOps),
    /miner runtime source mutated during copy: large\.js/,
    'in-place mutation while descriptor bytes are being copied must fail closed'
  );
  assert.equal(duringCopyMutationInjected, true, 'during-copy mutation regression must exercise the descriptor-read boundary');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner runtime source mutation regressions passed');
