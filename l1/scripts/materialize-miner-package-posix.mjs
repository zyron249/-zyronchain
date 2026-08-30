import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readlink, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

function assertProtocolText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\t\r\n]/.test(value)) {
    throw new Error(`${label} contains unsupported session protocol characters`);
  }
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel));
}

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
      reject(new Error(`custody session ended before ${JSON.stringify(expected)}`));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}

async function command(session, line, expected) {
  session.stdin.write(`${line}\n`);
  await waitForLine(session.stdout, expected);
}

async function copyTree(session, sourceRoot, sourceDir, destinationComponent) {
  assertProtocolText(destinationComponent, 'destination component');
  await command(session, `RESERVE\t${destinationComponent}`, 'OK RESERVE');
  await command(session, `ENTER\t${destinationComponent}`, 'OK ENTER');
  const entries = await readdir(sourceDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    assertProtocolText(entry.name, 'source entry');
    const sourcePath = join(sourceDir, entry.name);
    const sourceLstat = await lstat(sourcePath);
    if (sourceLstat.isDirectory()) {
      const canonical = await realpath(sourcePath);
      if (!isWithin(sourceRoot, canonical)) throw new Error(`miner package source directory escapes root: ${sourcePath}`);
      await copyTree(session, sourceRoot, canonical, entry.name);
      continue;
    }
    let copyPath = sourcePath;
    if (sourceLstat.isSymbolicLink()) {
      const link = await readlink(sourcePath);
      const canonical = await realpath(resolve(dirname(sourcePath), link));
      if (!isWithin(sourceRoot, canonical)) throw new Error(`miner package symlink escapes root: ${sourcePath}`);
      const target = await stat(canonical);
      if (!target.isFile()) throw new Error(`miner package symlink must resolve to a regular file: ${sourcePath}`);
      copyPath = canonical;
    } else if (!sourceLstat.isFile()) {
      throw new Error(`unsupported miner package source entry: ${sourcePath}`);
    }
    assertProtocolText(copyPath, 'copy source path');
    await command(session, `COPY\t${entry.name}\t${copyPath}`, 'OK COPY');
  }
  await command(session, 'LEAVE', 'OK LEAVE');
}

export async function materializeMinerPackagePosix({ root, outRoot, bundleName, nodeName }) {
  if (process.platform === 'win32') throw new Error('descriptor-relative miner materialization is not implemented on Windows');
  for (const [label, value] of Object.entries({ bundleName, nodeName })) assertProtocolText(value, label);

  const canonicalRoot = await realpath(root);
  const canonicalOutRoot = await realpath(outRoot);
  if (!isWithin(canonicalRoot, canonicalOutRoot) || relative(canonicalRoot, canonicalOutRoot) !== 'miner-release') {
    throw new Error('miner release root must be the canonical l1/miner-release directory');
  }

  const temp = await mkdtemp(join(tmpdir(), 'zyron-miner-materializer-'));
  const helper = join(temp, 'miner-custody-posix');
  const helperSource = join(canonicalRoot, 'native', 'miner-custody-posix.c');
  const compiler = process.env.CC || 'cc';
  const build = spawnSync(compiler, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', helperSource, '-o', helper], { encoding: 'utf8' });
  if (build.status !== 0) {
    await rm(temp, { recursive: true, force: true });
    throw new Error(`failed to compile descriptor-relative miner custody helper: ${build.stderr || build.stdout}`);
  }

  const launcherSource = join(temp, 'ZyronMiner');
  const readmeSource = join(temp, 'README.txt');
  await writeFile(launcherSource, '#!/bin/sh\nset -eu\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$HERE/node" "$HERE/scripts/miner-launcher.mjs"\n', 'utf8');
  await chmod(launcherSource, 0o755);
  await writeFile(readmeSource, [
    'ZyronChain self-contained miner runtime', '',
    'This package includes its own Node.js runtime and platform-native dependencies.',
    'Public mining remains activation-gated. Do not treat package availability as network activation.',
    'The first-launch bootstrap fails closed before creating custody unless the signed bundle contains an explicitly activated canonical network profile.',
    'Once activated, the bootstrap creates a random local password plus encrypted ZyronChain wallet under a non-symlink custody directory and starts mining against the bundled genesis/canonical HTTPS RPC.',
    'Miner RPC responses stay bounded and must pass API-version, network-identity, size, Content-Length, and JSON-structure checks before use.',
    'The website and RPC never receive the private key or wallet password.', '',
    'Start: ./ZyronMiner', '',
    'The website one-click button stays disabled until a canonical network profile, signed release assets, and public-mining activation are all available.'
  ].join('\n'), 'utf8');

  const session = spawn(helper, ['session', canonicalOutRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  session.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  try {
    await waitForLine(session.stdout, 'READY');
    await command(session, `RESERVE\t${bundleName}`, 'OK RESERVE');
    await command(session, `ENTER\t${bundleName}`, 'OK ENTER');
    await command(session, `COPY\t${nodeName}\t${process.execPath}`, 'OK COPY');
    await copyTree(session, canonicalRoot, join(canonicalRoot, 'dist', 'src'), 'dist-src');
    await copyTree(session, canonicalRoot, join(canonicalRoot, 'scripts'), 'scripts');
    await command(session, `COPY\tminer-network-profile.json\t${join(canonicalRoot, 'miner-network-profile.json')}`, 'OK COPY');
    await copyTree(session, canonicalRoot, join(canonicalRoot, 'node_modules'), 'node_modules');
    for (const name of ['package.json', 'MINING.md']) {
      await command(session, `COPY\t${name}\t${join(canonicalRoot, name)}`, 'OK COPY');
    }
    await command(session, `COPY\tZyronMiner\t${launcherSource}`, 'OK COPY');
    await command(session, `COPY\tREADME.txt\t${readmeSource}`, 'OK COPY');
    await command(session, 'LEAVE', 'OK LEAVE');
    await command(session, 'END', 'OK END');
    session.stdin.end();
    const exitCode = await new Promise((resolveExit, reject) => {
      session.once('error', reject);
      session.once('close', resolveExit);
    });
    if (exitCode !== 0) throw new Error(`descriptor-relative miner materialization failed: ${stderr}`);
  } catch (error) {
    session.kill('SIGKILL');
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  return join(canonicalOutRoot, bundleName);
}
