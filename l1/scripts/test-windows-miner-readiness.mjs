#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const doc = await readFile(resolve(here, '..', '..', 'docs', 'WINDOWS_MINER_READINESS.md'), 'utf8');
assert.match(doc, /Standalone L1 Node 22 and Node 24 green/);
assert.match(doc, /immutable versioned release/);
assert.match(doc, /Public mining activation remains a separate gate/);
console.log('Windows miner readiness contract: ok');
