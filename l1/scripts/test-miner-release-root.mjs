#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindMinerReleaseRoot } from './miner-release-root.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zyron-miner-release-root-'));
try {
  const project = path.join(temp, 'project');
  const releaseRoot = path.join(project, 'miner-release');
  const external = path.join(temp, 'external');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(releaseRoot);
  fs.mkdirSync(external);
  const sentinel = path.join(external, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'outside\n');

  assert.equal(bindMinerReleaseRoot(project, releaseRoot), fs.realpathSync(releaseRoot));

  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.symlinkSync(external, releaseRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => bindMinerReleaseRoot(project, releaseRoot),
    /miner release output root must be a real directory/
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside\n');

  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.writeFileSync(releaseRoot, 'not a directory\n');
  assert.throws(
    () => bindMinerReleaseRoot(project, releaseRoot),
    /miner release output root must be a real directory/
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside\n');

  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const packageSource = fs.readFileSync(path.join(scriptsDir, 'package-miner.mjs'), 'utf8');
  const bindIndex = packageSource.indexOf("const outRoot = bindMinerReleaseRoot(root, resolve(root, 'miner-release'));");
  const destructiveIndex = packageSource.indexOf('await rm(bundle, { recursive: true, force: true });');
  assert.ok(bindIndex >= 0, 'package-miner must bind the canonical release root');
  assert.ok(destructiveIndex > bindIndex, 'release-root binding must precede bundle cleanup/materialization');

  console.log('miner release root custody regression passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
