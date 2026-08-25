#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { releaseManifestPath } from './generate-miner-sha256sums.mjs';

const root = path.resolve('miner-release-path-control-test-root');

assert.equal(
  releaseManifestPath(root, path.join(root, 'nested', 'artifact.bin')),
  'nested/artifact.bin',
  'canonical release paths must remain root-relative and forward-slash normalized'
);

for (const [label, name] of [
  ['newline', 'bad\nname.bin'],
  ['carriage return', 'bad\rname.bin'],
  ['tab', 'bad\tname.bin'],
  ['unit separator', `bad${String.fromCharCode(0x1f)}name.bin`],
  ['DEL', `bad${String.fromCharCode(0x7f)}name.bin`]
]) {
  assert.throws(
    () => releaseManifestPath(root, path.join(root, name)),
    /miner release manifest path contains non-canonical control characters/,
    `${label} in a checksum-manifest path must fail closed`
  );
}

if (path.sep === '/') {
  const literalBackslashPath = `${root}/bad\\name.bin`;
  assert.throws(
    () => releaseManifestPath(root, literalBackslashPath),
    /miner release manifest path contains ambiguous backslash characters/,
    'a POSIX literal backslash must fail closed instead of being rewritten as a path separator'
  );
}

console.log('miner release manifest path-control regressions passed');
