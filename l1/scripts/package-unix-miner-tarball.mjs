#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform === 'win32') throw new Error('Unix miner archive packaging must run on Linux or macOS');
const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
if (!platform) throw new Error(`Unsupported Unix miner archive platform: ${process.platform}`);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const releaseRoot = join(root, 'miner-release');
const bundles = (await readdir(releaseRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith(`ZyronMiner-${platform}-`));
if (bundles.length !== 1) throw new Error(`Expected exactly one ${platform} miner bundle, found ${bundles.length}`);

const bundleName = bundles[0].name;
const archive = join(releaseRoot, `${bundleName}.tar.gz`);
const result = spawnSync('tar', ['-czf', basename(archive), bundleName], { cwd: releaseRoot, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`tar failed with status ${result.status}`);

const info = await stat(archive);
if (!info.isFile() || info.size < 1024) throw new Error('Unix miner archive is missing or unexpectedly small');
console.log(JSON.stringify({ bundle: relative(root, join(releaseRoot, bundleName)), archive: relative(root, archive), bytes: info.size, filename: basename(archive), platform }));
