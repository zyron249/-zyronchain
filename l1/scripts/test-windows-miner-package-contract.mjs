#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workflow = await readFile(resolve(root, '..', '.github', 'workflows', 'miner-release-candidate.yml'), 'utf8');
const packager = await readFile(resolve(here, 'package-windows-miner-zip.mjs'), 'utf8');

assert.match(workflow, /Package Windows end-user ZIP/);
assert.match(workflow, /ZyronMiner-windows-\*\.zip/);
assert.match(workflow, /publicMiningActivated: false/);
assert.match(workflow, /publicationAllowed: false/);
assert.match(packager, /Compress-Archive/);
assert.match(packager, /Windows miner ZIP packaging must run on Windows/);
console.log('Windows miner package contract: ok');
