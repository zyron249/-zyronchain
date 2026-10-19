#!/usr/bin/env node
// Static checks for the read-only wallet testnet page (website/testnet/).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(repo, 'website', 'testnet');
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const js = readFileSync(join(dir, 'testnet.js'), 'utf8');
const css = readFileSync(join(dir, 'testnet.css'), 'utf8');
const visible = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const NON_ENGLISH = /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

test('strict CSP, SRI and no inline code', () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const directives = Object.fromEntries(csp.split(';').map((part) => part.trim().split(/\s+/)).map(([key, ...rest]) => [key, rest.join(' ')]));
  assert.equal(directives['default-src'], "'none'");
  assert.equal(directives['script-src'], "'self'");
  assert.equal(directives['style-src'], "'self'");
  assert.equal(directives['connect-src'], 'https://zyron-wallet-testnet-rpc.onrender.com');
  assert.equal(directives['form-action'], "'none'");
  assert.equal(directives['base-uri'], "'none'");
  for (const key of ['object-src', 'frame-src', 'worker-src', 'font-src']) assert.equal(directives[key], "'none'", key);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=|style="/i);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  for (const name of ['testnet.css', 'testnet.js']) {
    const tag = html.match(new RegExp(`<(?:link|script)\\b[^>]*(?:href|src)="\\./${name}\\?v=([0-9a-f]{12})"[^>]*integrity="(sha384-[^"]+)"`));
    assert.ok(tag, name);
    const bytes = readFileSync(join(dir, name));
    assert.equal(tag[1], createHash('sha256').update(bytes).digest('hex').slice(0, 12));
    assert.equal(tag[2], 'sha384-' + createHash('sha384').update(bytes).digest('base64'));
  }
});

test('talks only to the wallet testnet RPC and never handles keys', () => {
  const urls = [...js.matchAll(/https:\/\/[^'"`\s]+/g)].map((match) => match[0]);
  assert.deepEqual(urls, ['https://zyron-wallet-testnet-rpc.onrender.com']);
  assert.match(js, /\/status/);
  assert.match(js, /\/account\//);
  assert.match(js, /\/tx/);
  assert.doesNotMatch(js, /getRandomValues|generateKey|importKey|deriveKey|subtle\.(sign|encrypt|decrypt|wrapKey|unwrapKey)|secp256k1|localStorage|sessionStorage|indexedDB|innerHTML|outerHTML|eval\(|new Function/);
  assert.match(js, /credentials:\s*'omit'/);
  assert.match(js, /valueBearing !== false/);
  assert.doesNotMatch(html, /type="password"|type="file"/);
  assert.match(visible, /never asks for a recovery phrase, a password or a private key/);
  assert.match(visible, /Next nonce to sign = nonce \+ 1/);
  assert.match(visible, /fresh genesis/);
  assert.match(js, /This looks like a recovery phrase/);
});

test('English only, no hype, linked from the site and listed in the sitemap', () => {
  for (const [name, source] of [['index.html', html], ['testnet.js', js], ['testnet.css', css]]) {
    assert.ok(!NON_ENGLISH.test(source), name);
  }
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(visible, /\bminers?\b|airdrop|APY|guaranteed|presale|buy now/i);
  const home = readFileSync(join(repo, 'website', 'index.html'), 'utf8');
  assert.match(home, /<a href="\.\/testnet\/">Testnet<\/a>/);
  assert.match(home, /<a href="\.\/testnet\/">Wallet testnet<\/a>/);
  assert.match(readFileSync(join(repo, 'website', 'sitemap.xml'), 'utf8'), /<loc>https:\/\/zyronchain\.com\/testnet\/<\/loc>/);
  const release = readFileSync(join(repo, 'website', 'release.js'), 'utf8').match(/const RELEASE_REF = '([0-9a-f]{40})';/)[1];
  assert.match(html, new RegExp(`data-site-build>Build ${release.slice(0, 8)}`));
  const wallet = readFileSync(join(repo, 'website', 'app', 'index.html'), 'utf8');
  assert.match(wallet, /connect-src 'none'/);
});

console.log(`testnet static tests passed: ${passed}`);
