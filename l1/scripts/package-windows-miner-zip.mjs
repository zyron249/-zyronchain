#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('Windows miner ZIP packaging must run on Windows');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const releaseRoot = join(root, 'miner-release');
const bundles = (await readdir(releaseRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('ZyronMiner-windows-'));
if (bundles.length !== 1) throw new Error(`Expected exactly one Windows miner bundle, found ${bundles.length}`);

const bundle = join(releaseRoot, bundles[0].name);
const zip = join(releaseRoot, `${bundles[0].name}.zip`);

// Use the Windows-native archive implementation available on GitHub-hosted runners.
// LiteralPath prevents wildcard/path interpretation of the reviewed bundle name.
const ps = [
  '$ErrorActionPreference = "Stop"',
  `if (Test-Path -LiteralPath '${zip.replaceAll("'", "''")}') { Remove-Item -LiteralPath '${zip.replaceAll("'", "''")}' -Force }`,
  `Compress-Archive -LiteralPath '${bundle.replaceAll("'", "''")}' -DestinationPath '${zip.replaceAll("'", "''")}' -CompressionLevel Optimal`
].join('; ');
const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`Compress-Archive failed with status ${result.status}`);

const info = await stat(zip);
if (!info.isFile() || info.size < 1024) throw new Error('Windows miner ZIP is missing or unexpectedly small');
console.log(JSON.stringify({ bundle: relative(root, bundle), zip: relative(root, zip), bytes: info.size, filename: basename(zip) }));
