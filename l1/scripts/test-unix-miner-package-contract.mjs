#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workflow = await readFile(resolve(root, '..', '.github', 'workflows', 'unix-miner-archive-candidate.yml'), 'utf8');

assert.match(workflow, /Prove Unix miner materialization is quarantined before filesystem writes/);
assert.match(workflow, /node scripts\/test-miner-packaging-quarantine\.mjs/);
assert.match(workflow, /Assert no Unix archive candidate was materialized/);
assert.match(workflow, /if \[ -e miner-release \]/);
assert.doesNotMatch(workflow, /Package Linux\/macOS end-user archive/);
assert.doesNotMatch(workflow, /actions\/upload-artifact/);
assert.doesNotMatch(workflow, /actions\/attest/);
console.log('Unix miner archive quarantine contract: ok');
