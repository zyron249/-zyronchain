#!/usr/bin/env node
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const profilePath = join(root, 'miner-network-profile.json');
const profile = JSON.parse(await readFile(profilePath, 'utf8'));

const exactKeys = ['schemaVersion', 'publicMiningActivated', 'chainId', 'genesisFile', 'rpcUrl'];
if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
    Object.keys(profile).sort().join('\n') !== [...exactKeys].sort().join('\n')) {
  throw new Error('Invalid bundled miner network profile fields');
}
if (profile.schemaVersion !== 1 || typeof profile.publicMiningActivated !== 'boolean') {
  throw new Error('Invalid bundled miner network profile version/activation');
}

// Stop before touching custody unless the release itself carries an explicitly
// activated, complete canonical network profile.
if (!profile.publicMiningActivated) {
  console.error('ZyronChain public mining is not activated in this signed release. No wallet or password was created.');
  process.exitCode = 78;
} else {
  if (typeof profile.chainId !== 'string' || !profile.chainId ||
      typeof profile.genesisFile !== 'string' || !profile.genesisFile ||
      typeof profile.rpcUrl !== 'string' || !profile.rpcUrl) {
    throw new Error('Activated miner profile is incomplete');
  }
  const rpc = new URL(profile.rpcUrl);
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.search || rpc.hash) {
    throw new Error('Activated public miner RPC must be canonical HTTPS without credentials/query/fragment');
  }
  if (isAbsolute(profile.genesisFile) || profile.genesisFile.includes('..')) {
    throw new Error('Bundled miner genesis path must stay inside the package');
  }

  const genesis = resolve(root, profile.genesisFile);
  if (!genesis.startsWith(`${root}/`) && process.platform !== 'win32') throw new Error('Genesis escaped miner package');
  await stat(genesis);

  const stateRoot = process.env.ZYRON_MINER_HOME
    ? resolve(process.env.ZYRON_MINER_HOME)
    : join(homedir(), '.zyronchain', 'miner');
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700).catch(() => {});

  const passwordPath = join(stateRoot, 'wallet.password');
  const keyPath = join(stateRoot, 'wallet.json');
  let keyExists = true;
  try { await stat(keyPath); } catch { keyExists = false; }

  if (!keyExists) {
    let passwordExists = true;
    try { await stat(passwordPath); } catch { passwordExists = false; }
    if (!passwordExists) {
      const password = randomBytes(32).toString('base64url');
      await writeFile(passwordPath, `${password}\n`, { flag: 'wx', mode: 0o600 });
      await chmod(passwordPath, 0o600).catch(() => {});
    }
    await run(process.execPath, [join(root, 'dist', 'src', 'cli.js'), 'keygen', '--out', keyPath, '--password-file', passwordPath]);
  }

  await chmod(keyPath, 0o600).catch(() => {});
  await chmod(passwordPath, 0o600).catch(() => {});
  await run(process.execPath, [
    join(root, 'scripts', 'mine.mjs'),
    '--genesis', genesis,
    '--key', keyPath,
    '--password-file', passwordPath,
    '--rpc', rpc.toString().replace(/\/$/, '')
  ], { inherit: true });
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: options.inherit ? 'inherit' : ['ignore', 'inherit', 'inherit'],
      windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) return reject(new Error(`Miner child terminated by signal ${signal}`));
      if (code !== 0) return reject(new Error(`Miner child exited with status ${code}`));
      resolvePromise();
    });
  });
}