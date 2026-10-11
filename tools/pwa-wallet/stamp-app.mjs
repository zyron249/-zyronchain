#!/usr/bin/env node
// Stamps website/app:
//   - versioned URLs (?v=<sha256 prefix>) + SRI hashes for every script and the stylesheet in index.html, so a CDN
//     can never pair new HTML with a stale cached script (each content change is a new URL);
//   - the build id meta tag (<meta name="zyron-build" content="app=<version>;release=<release ref>">);
//   - the integrity-checked, versioned asset list into sw.js.
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
const releaseJs = readFileSync(join(app, '..', 'release.js'), 'utf8');
const release = (releaseJs.match(/const RELEASE_REF = '([0-9a-f]{40})';/) || [])[1];
if (!release) throw new Error('website/release.js has no RELEASE_REF');

// Files that index.html loads with integrity="" (scripts + stylesheet), each with a content-versioned URL.
const SRI_FILES = ['app.css', 'vendor/noble-scure.js', 'vendor/qr.js', 'zyron-wallet-core.js', 'app.js'];
// Offline app shell (everything the page needs without network). Icons and the manifest keep plain URLs.
const PLAIN = ['index.html', 'manifest.json', 'icons/icon-192.png', 'icons/apple-touch-icon-180.png', 'icons/maskable-192.png'];
const fileVersion = (file) => sha256(read(file)).slice(0, 12);
const BUILD_META = /<meta name="zyron-build" content="[^"]*" \/>/;

let stale = [];
const original = read('index.html').toString('utf8');
let html = original;
for (const file of SRI_FILES) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`((?:src|href)="/app/${escaped})(?:\\?v=[0-9a-f]+)?(" integrity=")[^"]*(")`);
  if (!pattern.test(html)) throw new Error(`index.html does not load /app/${file} with an integrity attribute`);
  html = html.replace(pattern, `$1?v=${fileVersion(file)}$2${sri(file)}$3`);
}
if (!BUILD_META.test(html)) throw new Error('index.html is missing <meta name="zyron-build" content="..." />');

// The version covers every shell file (index.html with a neutral build meta), the worker's own logic and the release.
const assets = {};
const neutralHtml = html.replace(BUILD_META, '<meta name="zyron-build" content="" />');
for (const file of SRI_FILES) assets[`./${file}?v=${fileVersion(file)}`] = sha256(read(file));
const sw = read('sw.js').toString('utf8');
const swLogic = sw.replace(/\/\/ BEGIN GENERATED[\s\S]*?\/\/ END GENERATED/, '');
const version = sha256(Buffer.from(JSON.stringify(assets) + '\n' + sha256(Buffer.from(neutralHtml)) + '\n' + sha256(read('manifest.json')) + '\n' + swLogic + '\n' + release)).slice(0, 16);
html = html.replace(BUILD_META, `<meta name="zyron-build" content="app=${version};release=${release}" />`);
if (html !== original) { stale.push('index.html (SRI / versions / build id)'); if (!check) writeFileSync(join(app, 'index.html'), html); }

const ordered = {};
// PNGs are not hash-pinned: the CDN (Cloudflare image optimization) may re-encode them in transit.
for (const file of PLAIN) ordered[`./${file}`] = file.endsWith('.png') ? null : sha256(file === 'index.html' ? Buffer.from(html) : read(file));
Object.assign(ordered, assets);
const generated = `// BEGIN GENERATED (tools/pwa-wallet/stamp-app.mjs)\nconst VERSION = '${version}';\nconst ASSETS = ${JSON.stringify(ordered, null, 2)};\n// END GENERATED`;
const nextSw = sw.replace(/\/\/ BEGIN GENERATED[\s\S]*?\/\/ END GENERATED/, generated);
if (nextSw !== sw) { stale.push('sw.js (asset list)'); if (!check) writeFileSync(join(app, 'sw.js'), nextSw); }

if (check && stale.length) { console.error(`website/app is not stamped: ${stale.join(', ')}. Run node tools/pwa-wallet/stamp-app.mjs`); process.exit(1); }
console.log(`pwa-app-stamp-${check ? 'ok' : 'written'} version=${version} release=${release.slice(0, 8)}`);
