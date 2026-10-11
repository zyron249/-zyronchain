#!/usr/bin/env node
// Static regression tests for the zyronchain.com information site (no browser needed; runs in website CI).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROWS } from './network-status.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = join(repo, 'website');
const read = (rel) => readFileSync(join(site, rel), 'utf8');
const pages = readdirSync(site).filter((n) => n.endsWith('.html')).sort();
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
// Letters of other scripts / accented Latin letters (the math signs U+00D7 and U+00F7 are allowed).
const NON_ENGLISH = /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

test('English only: every page, script and stylesheet (no other-language letters, lang="en")', () => {
  const files = [...pages, 'app/index.html', ...readdirSync(site).filter((n) => /\.(js|css|json|txt|xml)$/.test(n)), 'app/app.js', 'app/app.css', 'app/manifest.json', 'README.md'];
  for (const file of files) {
    const text = read(file);
    const hit = text.match(NON_ENGLISH);
    assert.ok(!hit, `non-English letter ${hit && JSON.stringify(hit[0])} in website/${file}`);
    if (file.endsWith('.html')) assert.match(text, /<html lang="en"/, `website/${file} must declare lang="en"`);
  }
});

test('network status: the same honest rows on home, Desktop Wallet Setup and Phone Wallet', () => {
  const expected = new Map([
    ['governance', null], ['public-testnet', 'Not activated'], ['public-rpc', 'Unavailable'], ['explorer', 'Unavailable'],
    ['wallet-creation', 'Available locally'], ['offline-signing', 'Available'], ['broadcasting', 'Unavailable until activation'],
    ['mining', 'Retired'], ['token-sale', 'None']
  ]);
  assert.deepEqual(ROWS.map((r) => r.key), [...expected.keys()]);
  for (const row of ROWS) if (expected.get(row.key)) assert.equal(row.value, expected.get(row.key), row.key);
  for (const page of ['index.html', 'wallet.html', 'app/index.html']) {
    const html = read(page);
    assert.equal((html.match(/data-network-status/g) || []).length, 1, `${page}: one status component`);
    for (const row of ROWS) assert.ok(html.includes(`data-ns-row="${row.key}"`) && html.includes(row.value), `${page}: ${row.key}`);
    assert.ok(html.includes('Not a live feed; this page never contacts validator RPC.'), `${page}: static disclaimer`);
  }
});

test('honesty: no mainnet/testnet-live, sale, price or hype claims; Buy/Sell stays disabled', () => {
  for (const page of pages.filter((p) => p !== 'mining.html').concat('app/index.html')) {
    // Negated statements ("No presale", "not activated") are allowed; affirmative ones are not.
    const text = visible(read(page)).replace(/\s+/g, ' ').replace(/\b(no|not|never|without)\s+(a\s+|an\s+|the\s+)?[\w-]+/gi, ' ');
    for (const [re, what] of [
      [/\b(pre-?sale|buy now|guaranteed|to the moon|100x|APY|FDV|join the sale|whitelist spot)\b/i, 'hype or sale language'],
      [/\b(mainnet|public testnet|testnet) (is )?(now )?(live|launched|activated)\b/i, 'network-live claim'],
      [/\$\s?\d|USD\s?\d|\d+(\.\d+)?\s?(USDT|USDC)\b/, 'price-like figure']
    ]) {
      const hit = text.match(re);
      assert.ok(!hit, `${page}: ${what}: ${hit && JSON.stringify(text.slice(Math.max(0, hit.index - 40), hit.index + 40))}`);
    }
  }
  const home = read('index.html');
  assert.match(home, /<button class="btn" type="button" disabled>Buy \/ Sell not activated<\/button>/);
  assert.ok(home.includes('Final protocol fact') && home.includes('Proposed · under review') && home.includes('Pending governance'));
});

test('naming: Phone Wallet — Testnet (/app/) vs Desktop Wallet Setup (/wallet.html), Validator Launchpad', () => {
  const home = read('index.html');
  assert.match(home, /<a class="card" href="\.\/app\/">[\s\S]*?<h3>Phone Wallet — Testnet<\/h3>/);
  assert.match(home, /<a class="card" href="\.\/wallet\.html">[\s\S]*?<h3>Desktop Wallet Setup<\/h3>/);
  assert.match(home, /<a href="\.\/app\/">Phone Wallet — Testnet<\/a>/);
  assert.match(home, /<a href="\.\/wallet\.html">Desktop Wallet Setup<\/a>/);
  assert.match(home, /<a href="\.\/validator\.html">Validator Launchpad<\/a>/);
  const nav = home.match(/<nav class="site-nav"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...nav.matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]), ['Overview', 'Protocol', 'ZYN', 'Security', 'Developers', 'Network', 'Wallet']);
  for (const page of pages) assert.doesNotMatch(read(page), /Install on phone|📱|>Wallet Setup</, `${page}: old wallet naming`);
  assert.ok(read('wallet.html').includes('<title>ZyronChain — Desktop Wallet Setup</title>'));
});

test('mining is retired: no links, no CTAs, historical page noindex and out of the sitemap', () => {
  for (const page of pages.filter((p) => p !== 'mining.html').concat('app/index.html')) assert.doesNotMatch(read(page), /mining\.html|Start mining|Mine ZYN|Download (Zyron )?Miner/i, page);
  assert.doesNotMatch(read('app.js'), /MINER_DISTRIBUTION|ZyronMiner|location\.assign/);
  assert.match(read('mining.html'), /<meta name="robots" content="noindex" \/>/);
  assert.match(read('mining.html'), /Mining is retired/);
  assert.doesNotMatch(read('sitemap.xml'), /mining/);
});

test('build id: footer shows the canonical release reference; assets are content-versioned', () => {
  const release = read('release.js').match(/const RELEASE_REF = '([0-9a-f]{40})';/)[1];
  assert.ok(read('index.html').includes(`<span class="build" data-site-build>Build ${release.slice(0, 8)}</span>`));
  for (const page of pages) {
    for (const m of read(page).matchAll(/(?:href|src)="\.\/([a-z0-9-]+\.(?:css|js))(\?v=[0-9a-f]{12})?"/g)) assert.ok(m[2], `${page}: ./${m[1]} must carry ?v=`);
  }
});

test('SEO: canonical, OG/Twitter image, JSON-LD, sitemap/robots; /app/ stays noindex', () => {
  const home = read('index.html');
  for (const marker of ['<link rel="canonical" href="https://zyronchain.com/" />', 'property="og:image" content="https://zyronchain.com/brand/og-image.jpg"', 'name="twitter:card" content="summary_large_image"', 'application/ld+json', 'rel="apple-touch-icon"', 'rel="manifest" href="./site-manifest.json"']) assert.ok(home.includes(marker), marker);
  JSON.parse(home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.match(read('app/index.html'), /<meta name="robots" content="noindex/);
  assert.doesNotMatch(read('sitemap.xml'), /\/app\//);
  assert.match(read('robots.txt'), /Sitemap: https:\/\/zyronchain\.com\/sitemap\.xml/);
});

test('homepage works without JavaScript: no reveal-on-scroll hiding, hero image not lazy', () => {
  const home = read('index.html');
  assert.doesNotMatch(home, /data-reveal|reveal-ready/);
  const hero = home.match(/<section class="hero"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(hero, /loading="lazy"/);
  assert.match(hero, /fetchpriority="high"/);
  assert.match(home, /<script src="\.\/app\.js\?v=[0-9a-f]{12}"><\/script>\s*<\/body>/);
});

console.log(`site tests passed: ${passed}`);
