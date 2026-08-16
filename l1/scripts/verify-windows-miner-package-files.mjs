#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const file of ['package-windows-miner-zip.mjs', 'verify-windows-miner-zip.ps1', 'README-windows-miner-package.txt']) {
  await access(join(here, file));
}
const readme = await readFile(join(here, 'README-windows-miner-package.txt'), 'utf8');
assert.match(readme, /Double-click ZyronMiner\.cmd/i);
assert.match(readme, /Public mining is still activation-gated/);
console.log('Windows miner package files: ok');
