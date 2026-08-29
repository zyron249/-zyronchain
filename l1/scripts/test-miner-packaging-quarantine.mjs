#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MINER_PACKAGING_CUSTODY_ERROR } from './miner-packaging-custody-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const releaseRoot = resolve(root, 'miner-release');

if (existsSync(releaseRoot)) {
  throw new Error('quarantine regression requires miner-release to be absent before invocation');
}

const result = spawnSync(process.execPath, [resolve(here, 'package-miner.mjs')], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env }
});

if (result.status === 0) {
  throw new Error('miner packaging unexpectedly succeeded while custody quarantine is active');
}

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
if (!output.includes(MINER_PACKAGING_CUSTODY_ERROR)) {
  throw new Error(`missing fail-closed custody error; output was: ${output}`);
}

if (existsSync(releaseRoot)) {
  throw new Error('quarantined miner packaging created miner-release before failing closed');
}

console.log('miner packaging quarantine: ok');
