#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveMinerPackageTarget } from './miner-package-target.mjs';

assert.deepEqual(resolveMinerPackageTarget('linux', 'x64'), { platform: 'linux', arch: 'x64' });
assert.deepEqual(resolveMinerPackageTarget('linux', 'arm64'), { platform: 'linux', arch: 'arm64' });
assert.deepEqual(resolveMinerPackageTarget('darwin', 'x64'), { platform: 'macos', arch: 'x64' });
assert.deepEqual(resolveMinerPackageTarget('darwin', 'arm64'), { platform: 'macos', arch: 'arm64' });

for (const [platform, arch] of [
  ['win32', 'x64'],
  ['linux', 'ia32'],
  ['linux', 'ppc64'],
  ['darwin', 'ia32'],
  ['freebsd', 'x64']
]) {
  assert.throws(
    () => resolveMinerPackageTarget(platform, arch),
    /Unsupported miner package (platform|architecture)/
  );
}

console.log('miner package target regression: ok');
