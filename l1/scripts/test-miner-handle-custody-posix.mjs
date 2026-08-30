#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('POSIX miner custody primitive is unsupported on Windows; packaging remains fail-closed by quarantine.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = join(root, 'native', 'miner-custody-posix.c');
const temp = await mkdtemp(join(tmpdir(), 'zyron-miner-custody-'));
const helper = join(temp, 'miner-custody-posix');

try {
  const compiler = process.env.CC || 'cc';
  const build = spawnSync(compiler, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', helper], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`failed to compile custody helper: ${build.stderr || build.stdout}`);

  const release = join(temp, 'miner-release');
  await mkdir(release);

  const bind = spawnSync(helper, ['bind', release], { encoding: 'utf8' });
  if (bind.status !== 0 || !bind.stdout.startsWith('bound dev=')) throw new Error(`bind probe failed: ${bind.stderr}`);

  const reserve = spawnSync(helper, ['reserve', release, 'bundle'], { encoding: 'utf8' });
  if (reserve.status !== 0) throw new Error(`exclusive reserve failed: ${reserve.stderr}`);

  const duplicate = spawnSync(helper, ['reserve', release, 'bundle'], { encoding: 'utf8' });
  if (duplicate.status === 0) throw new Error('exclusive reserve unexpectedly reused an existing child');

  const traversal = spawnSync(helper, ['write', release, '../escape', 'X'], { encoding: 'utf8' });
  if (traversal.status === 0) throw new Error('custody helper accepted a non-component destination');

  console.log('PASS: POSIX miner custody primitive compiles, binds a directory descriptor, reserves exclusively, and rejects traversal components.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
