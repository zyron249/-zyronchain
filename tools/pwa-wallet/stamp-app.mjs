#!/usr/bin/env node
// Stamps website/app: SRI hashes into index.html and the integrity-checked, versioned asset list into sw.js.
//   node stamp-app.mjs          -> rewrite in place
//   node stamp-app.mjs --check  -> fail if anything is stale (CI)
// No dependencies: runs with plain Node, no npm install needed.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'website', 'app');
const check = process.argv.includes('--check');
const read = (file) => readFileSync(join(app, file));
const sri = (file) => `sha384-${createHash('sha384').update(read(file)).digest('base64')}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Files that index.html loads with integrity="" (scripts + stylesheet).
const SRI_FILES = ['app.css', 'vendor/noble-scure.js', 'vendor/qr.js', 'zyron-wallet-core.js', 'app.js'];
// Offline app shell (everything the page needs without network).
const SHELL = ['index.html', 'app.css', 'app.js', 'zyron-wallet-core.js', 'vendor/noble-scure.js', 'vendor/qr.js', 'manifest.json',
  'icons/icon-192.png', 'icons/apple-touch-icon-180.png', 'icons/maskable-192.png'];

let stale = [];
let html = read('index.html').toString('utf8');
for (const file of SRI_FILES) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`((?:src|href)="/app/${escaped}" integrity=")[^"]*(")`);
  if (!pattern.test(html)) throw new Error(`index.html does not load /app/${file} with an integrity attribute`);
  html = html.replace(pattern, `$1${sri(file)}$2`);
}
if (html !== read('index.html').toString('utf8')) { stale.push('index.html (SRI)'); if (!check) writeFileSync(join(app, 'index.html'), html); }

const assets = {};
// PNGs are not hash-pinned: the CDN (Cloudflare image optimization) may re-encode them in transit.
for (const file of SHELL) assets[`./${file}`] = file.endsWith('.png') ? null : sha256(file === 'index.html' ? Buffer.from(html) : read(file));
const sw = read('sw.js').toString('utf8');
// The version covers every shell file AND the worker's own logic (outside the generated block).
const swLogic = sw.replace(/\/\/ BEGIN GENERATED[\s\S]*?\/\/ END GENERATED/, '');
const version = sha256(Buffer.from(JSON.stringify(assets) + '\n' + swLogic)).slice(0, 16);
const generated = `// BEGIN GENERATED (tools/pwa-wallet/stamp-app.mjs)\nconst VERSION = '${version}';\nconst ASSETS = ${JSON.stringify(assets, null, 2)};\n// END GENERATED`;
const nextSw = sw.replace(/\/\/ BEGIN GENERATED[\s\S]*?\/\/ END GENERATED/, generated);
if (nextSw !== sw) { stale.push('sw.js (asset list)'); if (!check) writeFileSync(join(app, 'sw.js'), nextSw); }

if (check && stale.length) { console.error(`website/app is not stamped: ${stale.join(', ')}. Run node tools/pwa-wallet/stamp-app.mjs`); process.exit(1); }
console.log(`pwa-app-stamp-${check ? 'ok' : 'written'} version=${version}`);
