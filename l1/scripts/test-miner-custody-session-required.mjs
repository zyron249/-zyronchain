#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('PASS: POSIX custody session identity regression is not applicable on Windows.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const helperSource = resolve(here, '..', 'native', 'miner-custody-posix.c');
const temp = await mkdtemp(join(tmpdir(), 'zyron-custody-session-required-'));
const root = join(temp, 'miner-release');

try {
  await mkdir(root, { recursive: true });
  const helper = join(temp, 'miner-custody-posix');
  const compiler = process.env.CC || 'cc';
  const build = spawnSync(compiler, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', helperSource, '-o', helper], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`failed to compile custody helper: ${build.stderr || build.stdout}`);

  const unbound = spawnSync(helper, ['session', root], { input: 'RESERVE\tshould-not-exist\nEND\n', encoding: 'utf8' });
  if (unbound.status !== 64) throw new Error(`unbound session returned ${unbound.status}, expected 64`);
  if (unbound.stdout.includes('READY') || unbound.stdout.includes('OK RESERVE')) throw new Error('unbound session crossed READY/mutation boundary');
  if (!unbound.stderr.includes('session requires root path and expected dev/inode')) throw new Error('unbound session did not report required identity contract');

  const malformed = spawnSync(helper, ['session', root, 'not-a-device', 'not-an-inode'], { input: 'END\n', encoding: 'utf8' });
  if (malformed.status !== 64 || malformed.stdout.includes('READY')) throw new Error('malformed session identity reached READY');

  const stat = await lstat(root, { bigint: true });
  const valid = spawnSync(helper, ['session', root, String(stat.dev), String(stat.ino)], { input: 'END\n', encoding: 'utf8' });
  if (valid.status !== 0 || !valid.stdout.includes('READY') || !valid.stdout.includes('OK END')) throw new Error(`valid identity-bound session failed: ${valid.stderr || valid.stdout}`);

  const candidate = join(root, 'should-not-exist');
  try {
    await lstat(candidate);
    throw new Error('unbound session mutated the candidate root');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  console.log('PASS: every production POSIX custody session requires exact release-root dev/inode before READY or mutation.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
