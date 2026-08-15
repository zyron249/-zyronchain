#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(here, '..', 'genesis-message.json');
const raw = await readFile(path);
if (raw.length === 0 || raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
  throw new Error('genesis-message.json must be non-empty UTF-8 without BOM');
}
const value = JSON.parse(raw.toString('utf8'));
const keys = Object.keys(value).sort();
const expectedKeys = ['encoding', 'normalization', 'sha256', 'status', 'text', 'version'].sort();
if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
  throw new Error('genesis message manifest fields changed');
}
if (value.version !== 1 || value.encoding !== 'UTF-8' || value.normalization !== 'NFC') {
  throw new Error('unsupported genesis message manifest format');
}
if (value.status !== 'reserved-for-public-genesis-freeze') {
  throw new Error('genesis message activation status changed without public genesis review');
}
const expectedText = 'Şîfre hat çêkirin, rê hat vekirin. Xatirê we.';
if (value.text !== expectedText) throw new Error('canonical genesis message text changed');
if (value.text.normalize('NFC') !== value.text) throw new Error('canonical genesis message must remain NFC normalized');
const digest = createHash('sha256').update(Buffer.from(value.text, 'utf8')).digest('hex');
if (digest !== 'c458a9fd8d1fc11d5b0d19cda2b58fce4c689f5b458514d5a6891e6b993955f1') {
  throw new Error('canonical genesis message UTF-8 digest changed');
}
if (value.sha256 !== digest) throw new Error('genesis message manifest digest mismatch');
console.log(`canonical-genesis-message-ok ${digest}`);
