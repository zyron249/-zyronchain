#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, symlink } from 'node:fs/promises';
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

function waitForLine(stream, expected) {
  return new Promise((resolveLine, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trimEnd();
      cleanup();
      if (line !== expected) reject(new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(line)}`));
      else resolveLine(line);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`stream ended before ${JSON.stringify(expected)}`));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}

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

  const sessionRoot = join(temp, 'session-release');
  const heldRoot = join(temp, 'session-release-held');
  const external = join(temp, 'external-sentinel');
  await mkdir(sessionRoot);
  await mkdir(external);

  const session = spawn(helper, ['session', sessionRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  session.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  await waitForLine(session.stdout, 'READY');

  await rename(sessionRoot, heldRoot);
  await symlink(external, sessionRoot, 'dir');

  session.stdin.write('WRITE\tproof\tCANDIDATE\n');
  await waitForLine(session.stdout, 'OK WRITE');
  session.stdin.write('END\n');
  await waitForLine(session.stdout, 'OK END');
  session.stdin.end();

  const exitCode = await new Promise((resolveExit, reject) => {
    session.once('error', reject);
    session.once('close', resolveExit);
  });
  if (exitCode !== 0) throw new Error(`custody session failed: ${stderr}`);

  const heldPayload = await readFile(join(heldRoot, 'proof'), 'utf8');
  if (heldPayload !== 'CANDIDATE') throw new Error('held descriptor did not receive the candidate payload');

  let externalTouched = false;
  try {
    await readFile(join(external, 'proof'));
    externalTouched = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (externalTouched) throw new Error('replacement target received candidate bytes');

  console.log('PASS: POSIX miner custody primitive keeps one release-root descriptor across a session and writes zero candidate bytes through a raced pathname replacement.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
