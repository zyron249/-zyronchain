#!/usr/bin/env node
// Content-versions the static site's own CSS/JS references (./file.css?v=<sha256[:12]>) so a deploy never
// pairs new HTML with a stale stylesheet or script from a browser or CDN cache. Caching stays enabled; the URL
// changes whenever the bytes change. Run after editing website/*.css or website/*.js; CI runs it with --check.
// The phone wallet (website/app/) is versioned separately by tools/pwa-wallet/stamp-app.mjs.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = join(repo, 'website');
const check = process.argv.includes('--check');
const version = (file) => createHash('sha256').update(readFileSync(join(site, file))).digest('hex').slice(0, 12);
const REF = /(<link rel="stylesheet" href=|<script src=)"\.\/([a-z0-9-]+\.(?:css|js))(?:\?v=[0-9a-f]{12})?"/g;

let stale = 0;
for (const page of readdirSync(site).filter((name) => name.endsWith('.html')).sort()) {
  const path = join(site, page);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(REF, (_, prefix, file) => {
    if (!existsSync(join(site, file))) throw new Error(`${page} references missing asset ./${file}`);
    return `${prefix}"./${file}?v=${version(file)}"`;
  });
  if (after === before) continue;
  if (check) { stale += 1; console.error(`stale asset versions in website/${page}; run node tools/site/stamp-site.mjs`); continue; }
  writeFileSync(path, after);
  console.log(`site-stamp-written website/${page}`);
}
if (stale) process.exit(1);
console.log(check ? 'site-stamp-ok' : 'site-stamp-done');
