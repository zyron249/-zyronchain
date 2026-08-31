#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workflow = await readFile(resolve(root, '..', '.github', 'workflows', 'miner-release-candidate.yml'), 'utf8');

// The release-candidate workflow must exercise the real package entrypoint on
// Windows and require it to fail closed before creating candidate state. POSIX
// runners are allowed to construct one local, activation-gated candidate.
assert.match(workflow, /Prove Windows package entrypoint fails closed before writes/);
assert.match(workflow, /if: runner\.os == 'Windows'/);
assert.match(workflow, /if node scripts\/package-miner\.mjs >package-miner\.stdout 2>package-miner\.stderr; then/);
assert.match(workflow, /miner packaging custody is unsupported on this platform/);
assert.match(workflow, /if \[ -e miner-release \]/);
assert.match(workflow, /Construct audited POSIX release candidate/);
assert.match(workflow, /if: runner\.os != 'Windows'/);
assert.match(workflow, /node scripts\/package-miner\.mjs/);
assert.match(workflow, /Verify POSIX candidate remains local and inactive/);
assert.match(workflow, /publicMiningActivated !== false/);
assert.match(workflow, /p\.rpcUrl !== null/);
assert.match(workflow, /p\.genesisFile !== null/);
assert.doesNotMatch(workflow, /Package Windows end-user ZIP/);
assert.doesNotMatch(workflow, /actions\/upload-artifact/);
assert.doesNotMatch(workflow, /actions\/attest/);
console.log('Windows miner package fail-closed contract: ok');
