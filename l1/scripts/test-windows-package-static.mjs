#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, 'package-windows-miner-zip.mjs'), 'utf8');
assert.match(source, /Compress-Archive/);
assert.match(source, /LiteralPath/);
assert.match(source, /unexpectedly small/);
console.log('Windows package static smoke: ok');
