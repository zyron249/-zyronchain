#!/usr/bin/env node
// Content-versions and SRI-pins the light-client verify page.
//   node tools/site/stamp-verify.mjs
//   node tools/site/stamp-verify.mjs --check
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = join(repo, 'website');
const pagePath = join(site, 'verify', 'index.html');
const check = process.argv.includes('--check');
const release = readFileSync(join(site, 'release.js'), 'utf8').match(/const RELEASE_REF = '([0-9a-f]{40})';/);
if (!release) throw new Error('website/release.js has no canonical RELEASE_REF');

const assets = [
  ['../site.css', join(site, 'site.css')],
  ['./verify.css', join(site, 'verify', 'verify.css')],
  ['./vendor/secp256k1-verify.js', join(site, 'verify', 'vendor', 'secp256k1-verify.js')],
  ['./light-client.js', join(site, 'verify', 'light-client.js')],
  ['./session.js', join(site, 'verify', 'session.js')],
  ['./verify.js', join(site, 'verify', 'verify.js')]
];

function version(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
}
function sri(file) {
  return 'sha384-' + createHash('sha384').update(readFileSync(file)).digest('base64');
}

const before = readFileSync(pagePath, 'utf8');
let after = before;
for (const [href, file] of assets) {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`((?:href|src)="${escaped})(?:\\?v=[0-9a-f]{12})?(" integrity=")[^"]*(")`);
  if (!pattern.test(after)) throw new Error(`website/verify/index.html does not load ${href} with an integrity attribute`);
  after = after.replace(pattern, `$1?v=${version(file)}$2${sri(file)}$3`);
}
after = after.replace(/(<span class="build" data-site-build>)[^<]*(<\/span>)/, `$1Build ${release[1].slice(0, 8)}$2`);
if (after !== before) {
  if (check) {
    console.error('website/verify/index.html is stale; run node tools/site/stamp-verify.mjs');
    process.exit(1);
  }
  writeFileSync(pagePath, after);
  console.log('verify-stamp-written website/verify/index.html');
}
console.log(check ? 'verify-stamp-ok' : 'verify-stamp-done');
