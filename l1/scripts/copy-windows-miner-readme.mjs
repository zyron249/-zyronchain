#!/usr/bin/env node
import { copyFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') process.exit(0);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const releaseRoot = join(root, 'miner-release');
const bundle = (await readdir(releaseRoot, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.startsWith('ZyronMiner-windows-'));
if (!bundle) throw new Error('Windows miner bundle not found');
await copyFile(join(here, 'README-windows-miner-package.txt'), join(releaseRoot, bundle.name, 'START-HERE.txt'));
