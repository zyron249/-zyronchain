#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('POSIX miner source custody primitive is unsupported on Windows; packaging remains fail-closed.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = join(root, 'native', 'miner-source-custody-posix.c');
const temp = await mkdtemp(join(tmpdir(), 'zyron-miner-source-custody-'));
const helper = join(temp, 'miner-source-custody-posix');

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
      else resolveLine();
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

async function heldRead(sourceRoot, relativeFile, mutate) {
  const child = spawn(helper, ['hold-read', sourceRoot, relativeFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  await waitForLine(child.stdout, 'BOUND');
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  await mutate();
  child.stdin.write('\n');
  child.stdin.end();
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  if (exitCode !== 0) throw new Error(`source custody helper failed: ${stderr}`);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const compiler = process.env.CC || 'cc';
  const build = spawnSync(compiler, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', helper], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`failed to compile source custody helper: ${build.stderr || build.stdout}`);

  const sourceRoot = join(temp, 'source-root');
  const heldRoot = join(temp, 'source-root-held');
  const externalRoot = join(temp, 'external-source');
  await mkdir(join(sourceRoot, 'nested'), { recursive: true });
  await mkdir(join(externalRoot, 'nested'), { recursive: true });
  await writeFile(join(sourceRoot, 'nested', 'payload.bin'), 'ORIGINAL-CANDIDATE-SOURCE');
  await writeFile(join(externalRoot, 'nested', 'payload.bin'), 'ATTACKER-REPLACEMENT-SOURCE');

  const rootPayload = await heldRead(sourceRoot, 'nested/payload.bin', async () => {
    await rename(sourceRoot, heldRoot);
    await symlink(externalRoot, sourceRoot, 'dir');
  });
  if (rootPayload !== 'ORIGINAL-CANDIDATE-SOURCE') {
    throw new Error(`bound source root did not preserve original bytes; got ${JSON.stringify(rootPayload)}`);
  }

  const originalFile = join(heldRoot, 'nested', 'payload.bin');
  const heldFile = join(heldRoot, 'nested', 'payload-held.bin');
  const filePayload = await heldRead(heldRoot, 'nested/payload.bin', async () => {
    await rename(originalFile, heldFile);
    await writeFile(originalFile, 'ATTACKER-IN-ROOT-FILE-REPLACEMENT');
  });
  if (filePayload !== 'ORIGINAL-CANDIDATE-SOURCE') {
    throw new Error(`bound source file descriptor admitted replacement bytes; got ${JSON.stringify(filePayload)}`);
  }
  await rm(originalFile, { force: true });
  await rename(heldFile, originalFile);

  const nestedRoot = join(temp, 'nested-source-root');
  const nestedHeld = join(nestedRoot, 'nested-held');
  await mkdir(join(nestedRoot, 'nested'), { recursive: true });
  await writeFile(join(nestedRoot, 'nested', 'payload.bin'), 'ORIGINAL-NESTED-SOURCE');
  const nestedPayload = await heldRead(nestedRoot, 'nested/payload.bin', async () => {
    await rename(join(nestedRoot, 'nested'), nestedHeld);
    await symlink(join(externalRoot, 'nested'), join(nestedRoot, 'nested'), 'dir');
  });
  if (nestedPayload !== 'ORIGINAL-NESTED-SOURCE') {
    throw new Error(`bound nested source descriptor path admitted replacement bytes; got ${JSON.stringify(nestedPayload)}`);
  }

  const traversal = spawnSync(helper, ['read', heldRoot, '../external-source/nested/payload.bin'], { encoding: 'utf8' });
  if (traversal.status === 0) throw new Error('source custody helper accepted parent traversal');

  const finalSymlink = join(heldRoot, 'nested', 'link.bin');
  await symlink(join(externalRoot, 'nested', 'payload.bin'), finalSymlink);
  const symlinkRead = spawnSync(helper, ['read', heldRoot, 'nested/link.bin'], { encoding: 'utf8' });
  if (symlinkRead.status === 0) throw new Error('source custody helper followed a final-component symlink');

  console.log('PASS: POSIX miner source custody retains root/file identity across root, nested-directory, and file replacement; traversal/final symlinks remain rejected.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
