#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyMinerRuntimeTree } from './copy-miner-runtime-tree.mjs';

const noFollow = fs.constants.O_NOFOLLOW;
if (!Number.isInteger(noFollow) || noFollow === 0) {
  console.log('miner runtime durability regression skipped: O_NOFOLLOW unsupported and packaging already fails closed');
  process.exit(0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-runtime-durability-')));
try {
  const sourceRoot = path.join(root, 'source');
  const nestedSource = path.join(sourceRoot, 'nested');
  const destinationRoot = path.join(root, 'candidate');
  fs.mkdirSync(nestedSource, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'launcher.js'), 'launcher');
  fs.writeFileSync(path.join(nestedSource, 'worker.js'), 'worker');

  const openedPaths = new Map();
  const fsyncedPaths = [];
  const observingFsOps = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, ...args) => {
          const fd = fs.openSync(candidate, ...args);
          openedPaths.set(fd, path.resolve(candidate));
          return fd;
        };
      }
      if (property === 'closeSync') {
        return (fd) => {
          openedPaths.delete(fd);
          return fs.closeSync(fd);
        };
      }
      if (property === 'fsyncSync') {
        return (fd) => {
          fsyncedPaths.push(openedPaths.get(fd));
          return fs.fsyncSync(fd);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  copyMinerRuntimeTree(sourceRoot, destinationRoot, observingFsOps);

  const requiredDurabilityTargets = [
    path.join(destinationRoot, 'launcher.js'),
    path.join(destinationRoot, 'nested', 'worker.js'),
    path.join(destinationRoot, 'nested'),
    destinationRoot,
    path.dirname(destinationRoot)
  ].map((candidate) => path.resolve(candidate));
  for (const target of requiredDurabilityTargets) {
    assert.equal(
      fsyncedPaths.includes(target),
      true,
      `successful materialization must fsync ${target}`
    );
  }

  const failureSource = path.join(root, 'failure-source');
  const failureDestination = path.join(root, 'failure-candidate');
  const failureFile = path.resolve(path.join(failureDestination, 'tool.js'));
  fs.mkdirSync(failureSource);
  fs.writeFileSync(path.join(failureSource, 'tool.js'), 'validated');
  const failureOpenedPaths = new Map();
  let failureInjected = false;
  const failingFsOps = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, ...args) => {
          const fd = fs.openSync(candidate, ...args);
          failureOpenedPaths.set(fd, path.resolve(candidate));
          return fd;
        };
      }
      if (property === 'closeSync') {
        return (fd) => {
          failureOpenedPaths.delete(fd);
          return fs.closeSync(fd);
        };
      }
      if (property === 'fsyncSync') {
        return (fd) => {
          if (!failureInjected && failureOpenedPaths.get(fd) === failureFile) {
            failureInjected = true;
            const error = new Error('simulated miner runtime durability failure');
            error.code = 'EIO';
            throw error;
          }
          return fs.fsyncSync(fd);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(
    () => copyMinerRuntimeTree(failureSource, failureDestination, failingFsOps),
    /simulated miner runtime durability failure/,
    'destination fsync failures must fail closed instead of acknowledging candidate success'
  );
  assert.equal(failureInjected, true, 'durability failure regression must exercise destination file fsync');

  const replacementSource = path.join(root, 'replacement-source');
  const replacementDestination = path.join(root, 'replacement-candidate');
  const replacementFile = path.resolve(path.join(replacementDestination, 'tool.js'));
  const replacementTarget = path.join(replacementSource, 'replacement.js');
  fs.mkdirSync(replacementSource);
  fs.writeFileSync(path.join(replacementSource, 'tool.js'), 'validated');
  fs.writeFileSync(replacementTarget, 'attacker-replacement');
  const replacementOpenedPaths = new Map();
  let replacementInjected = false;
  const replacingFsOps = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, ...args) => {
          const fd = fs.openSync(candidate, ...args);
          replacementOpenedPaths.set(fd, path.resolve(candidate));
          return fd;
        };
      }
      if (property === 'closeSync') {
        return (fd) => {
          replacementOpenedPaths.delete(fd);
          return fs.closeSync(fd);
        };
      }
      if (property === 'fsyncSync') {
        return (fd) => {
          const result = fs.fsyncSync(fd);
          if (!replacementInjected && replacementOpenedPaths.get(fd) === replacementFile) {
            replacementInjected = true;
            fs.unlinkSync(replacementFile);
            fs.symlinkSync(replacementTarget, replacementFile);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(
    () => copyMinerRuntimeTree(replacementSource, replacementDestination, replacingFsOps),
    /miner runtime destination identity changed during copy: tool\.js/,
    'destination pathname replacement after descriptor open must fail closed'
  );
  assert.equal(replacementInjected, true, 'destination identity regression must exercise a post-open pathname replacement');
  assert.equal(fs.lstatSync(replacementFile).isSymbolicLink(), true, 'regression must leave a distinct replacement pathname for the identity check');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('miner runtime durability regressions passed');
