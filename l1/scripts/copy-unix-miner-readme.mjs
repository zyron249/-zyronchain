#!/usr/bin/env node
import { copyFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') process.exit(0);
const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
if (!platform) throw new Error(`Unsupported Unix miner archive platform: ${process.platform}`);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const releaseRoot = join(root, 'miner-release');
const bundles = (await readdir(releaseRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith(`ZyronMiner-${platform}-`));
if (bundles.length !== 1) throw new Error(`Expected exactly one ${platform} miner bundle, found ${bundles.length}`);
await copyFile(join(here, 'README-unix-miner-package.txt'), join(releaseRoot, bundles[0].name, 'START-HERE.txt'));
