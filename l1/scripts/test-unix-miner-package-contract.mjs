#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workflow = await readFile(resolve(root, '..', '.github', 'workflows', 'miner-release-candidate.yml'), 'utf8');
const packager = await readFile(resolve(here, 'package-unix-miner-tarball.mjs'), 'utf8');
const instructions = await readFile(resolve(here, 'README-unix-miner-package.txt'), 'utf8');

assert.match(workflow, /Package Linux\/macOS end-user archive/);
assert.match(workflow, /ZyronMiner-\$\{platform\}-\*\.tar\.gz|ZyronMiner-(?:linux|macos)-\*\.tar\.gz/);
assert.match(workflow, /publicMiningActivated: false/);
assert.match(workflow, /publicationAllowed: false/);
assert.match(packager, /spawnSync\('tar'/);
assert.match(packager, /unexpectedly small/);
assert.match(instructions, /\.\/ZyronMiner/);
assert.match(instructions, /Public mining is still activation-gated/);
console.log('Unix miner archive contract: ok');
