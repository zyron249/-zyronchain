// Static contract for /verify/: tight CSP, English, no keys, phone wallet untouched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const NON_ENGLISH = /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

const pageFiles = [
  'website/verify/index.html',
  'website/verify/verify.css',
  'website/verify/verify.js',
  'website/verify/session.js',
  'website/verify/light-client.js',
  'website/verify/test-light-client.mjs',
  'website/verify/test-session.mjs'
];

test('English only, lang=en, and no hype or price language', () => {
  for (const file of pageFiles) {
    const text = read(file);
    const hit = text.match(NON_ENGLISH);
    assert.ok(!hit, `${file} has a non-English letter ${hit && JSON.stringify(hit[0])}`);
  }
  const html = read('website/verify/index.html');
  assert.match(html, /<html lang="en"/);
  const text = visible(html).replace(/\s+/g, ' ').replace(/\b(no|not|never|without)\s+(a\s+|an\s+|the\s+)?[\w-]+/gi, ' ');
  assert.doesNotMatch(text, /\b(pre-?sale|buy now|guaranteed|to the moon|100x|APY|FDV)\b/i);
  assert.doesNotMatch(text, /\b(mainnet|public testnet|testnet) (is )?(now )?(live|launched|activated)\b/i);
  assert.doesNotMatch(text, /\$\s?\d|USD\s?\d|\d+(\.\d+)?\s?(USDT|USDC)\b/);
});

test('verify CSP allows only the open-testnet origin', () => {
  const html = read('website/verify/index.html');
  const metas = [...html.matchAll(/<meta\b[^>]*Content-Security-Policy[^>]*>/gi)];
  assert.equal(metas.length, 1);
  const content = metas[0][0].match(/content="([^"]*)"/)[1];
  const directives = Object.fromEntries(content.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...rest] = part.split(/\s+/);
    return [name, rest.join(' ')];
  }));
  assert.equal(directives['connect-src'], 'https://zyron-open-testnet.onrender.com');
  assert.equal(directives['default-src'], "'none'");
  assert.equal(directives['script-src'], "'self'");
  assert.equal(directives['object-src'], "'none'");
  assert.equal(directives['base-uri'], "'none'");
  assert.equal(directives['frame-src'], "'none'");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /\sstyle="/);
});

test('phone wallet CSP is still connect-src none and this page does not hold keys', () => {
  const wallet = read('website/app/index.html');
  const walletCsp = wallet.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(walletCsp, /connect-src 'none'/);
  assert.doesNotMatch(walletCsp, /onrender\.com/);
  for (const file of ['website/verify/verify.js', 'website/verify/session.js', 'website/verify/light-client.js', 'website/verify/index.html']) {
    const text = read(file);
    assert.doesNotMatch(text, /localStorage|indexedDB|sessionStorage|privateKey|generatePrivateKey|signCanonical|WebSocket/i, file);
  }
});

test('homepage and sitemap link the verifier, and the page names testnet', () => {
  assert.match(read('website/index.html'), /href="\.\/verify\/"/);
  assert.match(read('website/sitemap.xml'), /<loc>https:\/\/zyronchain\.com\/verify\/<\/loc>/);
  const html = read('website/verify/index.html');
  assert.match(html, /data-chain/);
  assert.match(html, /data-verified-height/);
  assert.match(html, /data-checks/);
  assert.match(html, /testnet/);
  assert.match(html, /not a validator/i);
});

console.log(`verify page tests passed: ${passed}`);
