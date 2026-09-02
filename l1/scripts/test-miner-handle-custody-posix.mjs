#!/usr/bin/env node
import { appendFileSync, truncateSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
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

async function finishSession(session, stderrRef) {
  session.stdin.write('END\n');
  await waitForLine(session.stdout, 'OK END');
  session.stdin.end();
  const exitCode = await new Promise((resolveExit, reject) => {
    session.once('error', reject);
    session.once('close', resolveExit);
  });
  if (exitCode !== 0) throw new Error(`custody session failed: ${stderrRef()}`);
}

async function assertAbsent(path, message) {
  try {
    await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}

async function bindSource(session, sourceRoot) {
  const stat = await lstat(sourceRoot);
  if (!stat.isDirectory()) throw new Error(`test source root is not a directory: ${sourceRoot}`);
  session.stdin.write(`SOURCE\t${sourceRoot}\t${String(stat.dev)}\t${String(stat.ino)}\n`);
  await waitForLine(session.stdout, 'OK SOURCE');
}

async function copyRel(session, destinationName, sourceName, sourcePath) {
  const stat = await lstat(sourcePath);
  if (!stat.isFile()) throw new Error(`test COPYREL source is not a regular file: ${sourcePath}`);
  session.stdin.write(`COPYREL\t${destinationName}\t${sourceName}\t${String(stat.dev)}\t${String(stat.ino)}\n`);
  await waitForLine(session.stdout, 'OK COPYREL');
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
  await finishSession(session, () => stderr);

  const heldPayload = await readFile(join(heldRoot, 'proof'), 'utf8');
  if (heldPayload !== 'CANDIDATE') throw new Error('held descriptor did not receive the candidate payload');
  await assertAbsent(join(external, 'proof'), 'replacement target received candidate bytes');

  const bundleRoot = join(temp, 'bundle-release');
  const bundleExternal = join(temp, 'bundle-external-sentinel');
  await mkdir(bundleRoot);
  await mkdir(bundleExternal);

  const bundleSession = spawn(helper, ['session', bundleRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  let bundleStderr = '';
  bundleSession.stderr.on('data', (chunk) => { bundleStderr += chunk.toString('utf8'); });
  await waitForLine(bundleSession.stdout, 'READY');

  bundleSession.stdin.write('RESERVE\tbundle\n');
  await waitForLine(bundleSession.stdout, 'OK RESERVE');
  bundleSession.stdin.write('ENTER\tbundle\n');
  await waitForLine(bundleSession.stdout, 'OK ENTER');

  const bundlePath = join(bundleRoot, 'bundle');
  const heldBundle = join(bundleRoot, 'bundle-held');
  await rename(bundlePath, heldBundle);
  await symlink(bundleExternal, bundlePath, 'dir');

  bundleSession.stdin.write('WRITE\tproof\tBUNDLE-CANDIDATE\n');
  await waitForLine(bundleSession.stdout, 'OK WRITE');
  bundleSession.stdin.write('LEAVE\n');
  await waitForLine(bundleSession.stdout, 'OK LEAVE');
  await finishSession(bundleSession, () => bundleStderr);

  const heldBundlePayload = await readFile(join(heldBundle, 'proof'), 'utf8');
  if (heldBundlePayload !== 'BUNDLE-CANDIDATE') throw new Error('held bundle descriptor did not receive the candidate payload');
  await assertAbsent(join(bundleExternal, 'proof'), 'bundle replacement target received candidate bytes');

  const nestedRoot = join(temp, 'nested-release');
  const nestedExternal = join(temp, 'nested-external-sentinel');
  const copySourceDir = join(temp, 'copy-source');
  const copySource = join(copySourceDir, 'copy-source.bin');
  const binaryPayload = Buffer.from([0, 1, 2, 3, 255, 10, 13, 42]);
  await mkdir(copySourceDir);
  await writeFile(copySource, binaryPayload);
  await mkdir(nestedRoot);
  await mkdir(nestedExternal);

  const nested = spawn(helper, ['session', nestedRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  let nestedStderr = '';
  nested.stderr.on('data', (chunk) => { nestedStderr += chunk.toString('utf8'); });
  await waitForLine(nested.stdout, 'READY');

  await bindSource(nested, copySourceDir);
  nested.stdin.write('RESERVE\tbundle\n');
  await waitForLine(nested.stdout, 'OK RESERVE');
  nested.stdin.write('ENTER\tbundle\n');
  await waitForLine(nested.stdout, 'OK ENTER');
  nested.stdin.write('RESERVE\tscripts\n');
  await waitForLine(nested.stdout, 'OK RESERVE');
  nested.stdin.write('ENTER\tscripts\n');
  await waitForLine(nested.stdout, 'OK ENTER');

  const scriptsPath = join(nestedRoot, 'bundle', 'scripts');
  const heldScripts = join(nestedRoot, 'bundle', 'scripts-held');
  await rename(scriptsPath, heldScripts);
  await symlink(nestedExternal, scriptsPath, 'dir');

  nested.stdin.write('WRITE\tmine.mjs\tNESTED-CANDIDATE\n');
  await waitForLine(nested.stdout, 'OK WRITE');
  await copyRel(nested, 'node.bin', 'copy-source.bin', copySource);
  nested.stdin.write('LEAVE\n');
  await waitForLine(nested.stdout, 'OK LEAVE');
  nested.stdin.write('LEAVE\n');
  await waitForLine(nested.stdout, 'OK LEAVE');
  await finishSession(nested, () => nestedStderr);

  const nestedPayload = await readFile(join(heldScripts, 'mine.mjs'), 'utf8');
  if (nestedPayload !== 'NESTED-CANDIDATE') throw new Error('nested held descriptor did not receive the candidate payload');
  const copiedPayload = await readFile(join(heldScripts, 'node.bin'));
  if (!copiedPayload.equals(binaryPayload)) throw new Error('descriptor-relative COPYREL changed binary candidate bytes');
  await assertAbsent(join(nestedExternal, 'mine.mjs'), 'nested replacement target received candidate bytes');
  await assertAbsent(join(nestedExternal, 'node.bin'), 'nested replacement target received copied candidate bytes');

  const mutationRoot = join(temp, 'mutation-release');
  const mutationSourceDir = join(temp, 'mutation-source');
  const mutationSource = join(mutationSourceDir, 'large.bin');
  const stableSize = 64 * 1024 * 1024;
  await mkdir(mutationRoot);
  await mkdir(mutationSourceDir);
  await writeFile(mutationSource, Buffer.alloc(stableSize, 0x5a));

  const mutationSession = spawn(helper, ['session', mutationRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  let mutationStderr = '';
  mutationSession.stderr.on('data', (chunk) => { mutationStderr += chunk.toString('utf8'); });
  await waitForLine(mutationSession.stdout, 'READY');
  await bindSource(mutationSession, mutationSourceDir);
  mutationSession.stdin.write('RESERVE\tbundle\n');
  await waitForLine(mutationSession.stdout, 'OK RESERVE');
  mutationSession.stdin.write('ENTER\tbundle\n');
  await waitForLine(mutationSession.stdout, 'OK ENTER');

  const mutationExit = new Promise((resolveExit, reject) => {
    mutationSession.once('error', reject);
    mutationSession.once('close', resolveExit);
  });
  const mutationStat = await lstat(mutationSource);
  mutationSession.stdin.write(`COPYREL\tlarge.bin\tlarge.bin\t${String(mutationStat.dev)}\t${String(mutationStat.ino)}\n`);
  const mutator = setInterval(() => {
    try {
      appendFileSync(mutationSource, Buffer.from([0x41]));
      truncateSync(mutationSource, stableSize);
    } catch {
      // The helper may exit while the interval is being cleared below.
    }
  }, 1);
  const mutationCode = await mutationExit;
  clearInterval(mutator);
  if (mutationCode === 0) throw new Error('COPYREL accepted a source that mutated during retained copy');
  if (!mutationStderr.includes('retained copy source mutated during read')) {
    throw new Error(`COPYREL mutation did not fail at the stable-source snapshot boundary: ${mutationStderr}`);
  }

  console.log('PASS: POSIX miner custody retains destination/source descriptors across pathname replacement, binds COPYREL to the expected source inode, and fails closed when a retained source mutates during copy.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
