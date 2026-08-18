#!/usr/bin/env node
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import { ensureSafeCustodyDirectory, existingSafeSecret, safeBundledRegularFile } from './miner-launcher-security.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const profilePath = await safeBundledRegularFile(root, 'miner-network-profile.json', 'Bundled miner network profile');
const profile = JSON.parse(await readFile(profilePath, 'utf8'));

const exactKeys = ['schemaVersion', 'publicMiningActivated', 'chainId', 'genesisFile', 'rpcUrl'];
if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
    Object.keys(profile).sort().join('\n') !== [...exactKeys].sort().join('\n')) {
  throw new Error('Invalid bundled miner network profile fields');
}
if (profile.schemaVersion !== 1 || typeof profile.publicMiningActivated !== 'boolean') {
  throw new Error('Invalid bundled miner network profile version/activation');
}

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

  const genesis = await safeBundledRegularFile(root, profile.genesisFile, 'Bundled miner genesis');

  const requestedStateRoot = process.env.ZYRON_MINER_HOME
    ? resolve(process.env.ZYRON_MINER_HOME)
    : join(homedir(), '.zyronchain', 'miner');
  const stateRoot = await ensureSafeCustodyDirectory(requestedStateRoot);
  await chmod(stateRoot, 0o700).catch(() => {});

  const passwordPath = join(stateRoot, 'wallet.password');
  const keyPath = join(stateRoot, 'wallet.json');
  const keyExists = await existingSafeSecret(keyPath, 'Miner wallet');
  let passwordExists = await existingSafeSecret(passwordPath, 'Miner password');

  if (!keyExists) {
    if (!passwordExists) {
      const password = randomBytes(32).toString('base64url');
      await writeFile(passwordPath, `${password}\n`, { flag: 'wx', mode: 0o600 });
      passwordExists = true;
    }
    await run(process.execPath, [join(root, 'dist', 'src', 'cli.js'), 'keygen', '--out', keyPath, '--password-file', passwordPath]);
  } else if (!passwordExists) {
    throw new Error('Miner wallet exists but its password file is missing; refusing to replace custody material');
  }

  if (!await existingSafeSecret(keyPath, 'Miner wallet') || !await existingSafeSecret(passwordPath, 'Miner password')) {
    throw new Error('Miner custody material is incomplete');
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
