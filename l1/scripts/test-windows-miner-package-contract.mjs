#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workflow = await readFile(resolve(root, '..', '.github', 'workflows', 'miner-release-candidate.yml'), 'utf8');

assert.match(workflow, /Prove release-candidate materialization is quarantined before filesystem writes/);
assert.match(workflow, /node scripts\/test-miner-packaging-quarantine\.mjs/);
assert.match(workflow, /Assert no release candidate was materialized/);
assert.match(workflow, /if \[ -e miner-release \]/);
assert.doesNotMatch(workflow, /Package Windows end-user ZIP/);
assert.doesNotMatch(workflow, /actions\/upload-artifact/);
assert.doesNotMatch(workflow, /actions\/attest/);
console.log('Windows miner package quarantine contract: ok');
