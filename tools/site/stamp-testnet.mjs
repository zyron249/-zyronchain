#!/usr/bin/env node
// Content-versions and SRI-pins website/testnet/testnet.css and testnet.js, and writes the footer build id.
//   node tools/site/stamp-testnet.mjs          rewrite in place
//   node tools/site/stamp-testnet.mjs --check  fail if stale (CI)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(repo, 'website', 'testnet');
const pagePath = join(dir, 'index.html');
const check = process.argv.includes('--check');
const release = readFileSync(join(repo, 'website', 'release.js'), 'utf8').match(/const RELEASE_REF = '([0-9a-f]{40})';/);
if (!release) throw new Error('website/release.js has no canonical RELEASE_REF');
const version = (name) => createHash('sha256').update(readFileSync(join(dir, name))).digest('hex').slice(0, 12);
const sri = (name) => 'sha384-' + createHash('sha384').update(readFileSync(join(dir, name))).digest('base64');

const before = readFileSync(pagePath, 'utf8');
let after = before;
for (const name of ['testnet.css', 'testnet.js']) {
  const pattern = new RegExp(`((?:href|src)="\\./${name.replace('.', '\\.')})(?:\\?v=[0-9a-f]+)?(" integrity=")[^"]*(")`);
  if (!pattern.test(after)) throw new Error(`website/testnet/index.html does not load ./${name} with an integrity attribute`);
  after = after.replace(pattern, `$1?v=${version(name)}$2${sri(name)}$3`);
}
after = after.replace(/(<span class="build" data-site-build>)[^<]*(<\/span>)/, `$1Build ${release[1].slice(0, 8)}$2`);
if (after !== before) {
  if (check) {
    console.error('website/testnet/index.html is stale; run node tools/site/stamp-testnet.mjs');
    process.exit(1);
  }
  writeFileSync(pagePath, after);
  console.log('testnet-stamp-written website/testnet/index.html');
}
console.log(check ? 'testnet-stamp-ok' : 'testnet-stamp-done');
