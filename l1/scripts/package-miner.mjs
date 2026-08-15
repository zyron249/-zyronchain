#!/usr/bin/env node
import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outRoot = resolve(root, 'miner-release');
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
if (!platform) throw new Error(`Unsupported miner package platform: ${process.platform}`);

const arch = process.arch;
const bundleName = `ZyronMiner-${platform}-${arch}`;
const bundle = join(outRoot, bundleName);
await rm(bundle, { recursive: true, force: true });
await mkdir(join(bundle, 'scripts'), { recursive: true });
await mkdir(join(bundle, 'dist'), { recursive: true });

const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
await cp(process.execPath, join(bundle, nodeName));
await cp(join(root, 'dist', 'src'), join(bundle, 'dist', 'src'), { recursive: true });
await cp(join(root, 'scripts', 'mine.mjs'), join(bundle, 'scripts', 'mine.mjs'));
await cp(join(root, 'node_modules'), join(bundle, 'node_modules'), { recursive: true });
await cp(join(root, 'package.json'), join(bundle, 'package.json'));
await cp(join(root, 'MINING.md'), join(bundle, 'MINING.md'));

if (process.platform === 'win32') {
  await writeFile(join(bundle, 'ZyronMiner.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0scripts\\mine.mjs" %*\r\n', 'utf8');
} else {
  const launcher = join(bundle, 'ZyronMiner');
  await writeFile(launcher, '#!/bin/sh\nset -eu\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$HERE/node" "$HERE/scripts/mine.mjs" "$@"\n', 'utf8');
  await chmod(launcher, 0o755);
  await chmod(join(bundle, nodeName), 0o755);
}

await writeFile(join(bundle, 'README.txt'), [
  'ZyronChain self-contained miner runtime',
  '',
  'This package includes its own Node.js runtime and platform-native dependencies.',
  'Public mining remains activation-gated. Do not treat package availability as network activation.',
  'The miner accepts encrypted ZyronChain keystores only and never sends private keys/passwords to RPC.',
  '',
  'Current expert invocation:',
  process.platform === 'win32'
    ? 'ZyronMiner.cmd --genesis <genesis.json> --key <wallet.json> --password-file <wallet.password> --rpc <https-url>'
    : './ZyronMiner --genesis <genesis.json> --key <wallet.json> --password-file <wallet.password> --rpc <https-url>',
  '',
  'The website one-click button stays disabled until a canonical network profile, signed release assets, and public-mining activation are all available.'
].join('\n'), 'utf8');

console.log(JSON.stringify({ bundle, bundleName, platform, arch, runtime: basename(process.execPath) }));