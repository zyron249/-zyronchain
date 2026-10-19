#!/usr/bin/env node
// Headless Chrome checks for website/testnet/ against a mocked wallet-testnet RPC.
//   CHROME_PATH=/usr/bin/google-chrome node tools/site/test-testnet-browser.mjs [--shots <dir>]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = join(repo, 'website');
const { chromium } = createRequire(join(repo, 'tools', 'pwa-wallet', 'package.json'))('playwright-core');
const chromePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/local/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!chromePath) throw new Error('Chrome not found');
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const ADDR = 'ZYN09c0b2d1a486c439a87bcba6b46a7a1a23f3897c';
const CHECKSUM = 'ZYN09C0B2D1A486C439A87bCbA6b46A7a1A23F3897c';
const WRONG = 'ZYN09c0B2D1A486C439A87bCbA6b46A7a1A23F3897c';
const RECEIVER = 'ZYN5d99ee966b42cd8fc7bdd1364b389153a9e78b42';
const GENESIS = 'ab'.repeat(32);
const statusBody = { network: 'testnet', valueBearing: false, chainId: 'zyron-wallet-testnet-1', genesisHash: GENESIS, height: 4, transactionVersion: 1, notice: 'Test ZYN has no value.', stateDurable: false, restoredTxCount: 0, restoredAccounts: 0 };
const balances = new Map([[ADDR, 250000000], [RECEIVER, 0]]);
const nonces = new Map([[ADDR, 0], [RECEIVER, 0]]);
let posted = null;
const accountReads = [];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(site, path));
  if (!file.startsWith(site) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };

function account(address) {
  return { network: 'testnet', valueBearing: false, chainId: 'zyron-wallet-testnet-1', height: 4, address, balanceAtoms: balances.get(address) ?? 0, nonce: nonces.get(address) ?? 0 };
}
function transfer(overrides = {}) {
  return {
    kind: 'transfer', version: 1, chainId: 'zyron-wallet-testnet-1', nonce: 1,
    sender: ADDR, receiver: RECEIVER, amountAtoms: 100000000, feeAtoms: 0, timestampMs: 1700000000000,
    publicKey: 'ab'.repeat(64), signature: 'cd'.repeat(64), txid: 'ef'.repeat(32),
    ...overrides
  };
}
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'content-type': 'application/json' };

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('https://zyron-wallet-testnet-rpc.onrender.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(request.url());
    if (url.pathname === '/status') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(statusBody) });
    if (url.pathname.startsWith('/account/')) {
      const address = decodeURIComponent(url.pathname.slice('/account/'.length));
      accountReads.push(address);
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(account(address)) });
    }
    if (url.pathname === '/tx' && request.method() === 'POST') {
      posted = JSON.parse(request.postData());
      balances.set(posted.receiver, (balances.get(posted.receiver) ?? 0) + posted.amountAtoms);
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ accepted: true, txid: posted.txid }) });
    }
    return route.fulfill({ status: 404, headers: cors, body: JSON.stringify({ error: 'not found' }) });
  });

  await test('lookup shows balance, nonce, next nonce, height and genesis', async () => {
    await page.goto(base + '/testnet/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('[data-chain]').textContent === 'zyron-wallet-testnet-1');
    assert.equal(await page.textContent('[data-tx-version]'), '1');
    assert.equal(await page.textContent('[data-genesis]'), GENESIS);
    assert.match(await page.textContent('body'), /durable storage is on/);
    assert.match(await page.textContent('body'), /deliberately reset/);
    assert.equal(await page.textContent('[data-durable]'), 'off');
    assert.match(await page.textContent('body'), /never asks for a recovery phrase/);
    await page.fill('[data-address]', ADDR);
    await page.click('[data-lookup]');
    await page.waitForFunction(() => document.querySelector('[data-acc-zyn]').textContent === '2.5 ZYN');
    assert.equal(await page.textContent('[data-acc-atoms]'), '250000000');
    assert.equal(await page.textContent('[data-acc-nonce]'), '0');
    assert.equal(await page.textContent('[data-acc-next]'), '1');
    assert.equal(await page.textContent('[data-acc-height]'), '4');
    assert.equal(await page.textContent('[data-acc-genesis]'), GENESIS);
    assert.match(await page.textContent('body'), /Next nonce to sign = nonce \+ 1/);
    const narrow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
    assert.ok(narrow.sw <= narrow.vw, `mobile overflow ${narrow.sw} > ${narrow.vw}`);
    if (shots) await page.screenshot({ path: join(shots, 'testnet-lookup-mobile.png'), fullPage: true });
  });

  await test('checksummed lookup is accepted and a wrong checksum is rejected before any account read', async () => {
    const before = accountReads.length;
    await page.fill('[data-address]', CHECKSUM);
    await page.click('[data-lookup]');
    await page.waitForFunction(() => /Checksum verified/.test(document.querySelector('[data-lookup-msg]').textContent));
    assert.equal(await page.textContent('[data-acc-address]'), ADDR);
    assert.ok(accountReads.slice(before).includes(ADDR), 'checksummed input is sent as lowercase');
    assert.ok(accountReads.slice(before).every((address) => address === ADDR));
    const afterChecksum = accountReads.length;
    await page.fill('[data-address]', WRONG);
    await page.click('[data-lookup]');
    await page.waitForFunction(() => /checksum mismatch/i.test(document.querySelector('[data-lookup-msg]').textContent));
    assert.equal(accountReads.length, afterChecksum, 'wrong checksum does not call the RPC');
  });

  await test('a phrase, a version mismatch and a chain mismatch are rejected; a matching transfer submits', async () => {
    await page.fill('[data-tx]', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    await page.click('[data-tx-review]');
    assert.match(await page.textContent('[data-tx-msg]'), /recovery phrase/);
    assert.equal(await page.isDisabled('[data-submit]'), true);
    await page.fill('[data-tx]', JSON.stringify(transfer({ version: 2 })));
    await page.click('[data-tx-review]');
    assert.match(await page.textContent('[data-tx-msg]'), /version 2 does not match/);
    await page.fill('[data-tx]', JSON.stringify(transfer({ chainId: 'zyron-other-testnet' })));
    await page.click('[data-tx-review]');
    assert.match(await page.textContent('[data-tx-msg]'), /Chain ID does not match/);
    await page.fill('[data-tx]', JSON.stringify(transfer()));
    await page.click('[data-tx-review]');
    await page.waitForSelector('[data-review]:not([hidden])');
    assert.equal(await page.textContent('[data-rev-from]'), ADDR);
    assert.equal(await page.textContent('[data-rev-to]'), RECEIVER);
    assert.match(await page.textContent('[data-rev-amount]'), /1 ZYN \(100000000 atoms\)/);
    assert.match(await page.textContent('[data-rev-fee]'), /0 ZYN/);
    assert.equal(await page.textContent('[data-rev-nonce]'), '1');
    assert.equal(await page.isDisabled('[data-submit]'), false);
    assert.equal(posted, null, 'review does not submit');
    if (shots) await page.screenshot({ path: join(shots, 'testnet-review-mobile.png'), fullPage: true });
    await page.click('[data-submit]');
    await page.waitForFunction(() => /Included/.test(document.querySelector('[data-submit-msg]').textContent));
    assert.equal(posted.sender, ADDR);
    assert.equal(posted.receiver, RECEIVER);
    assert.match(await page.textContent('[data-submit-msg]'), new RegExp(posted.txid));
    assert.match(await page.textContent('[data-submit-msg]'), /1 ZYN/);
  });

  await test('desktop layout has no horizontal overflow and the CSP is the page policy', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + '/testnet/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('[data-chain]').textContent === 'zyron-wallet-testnet-1');
    const box = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
    assert.ok(box.sw <= box.vw, `horizontal overflow ${box.sw} > ${box.vw}`);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src https:\/\/zyron-wallet-testnet-rpc\.onrender\.com(;|$)/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.doesNotMatch(csp, /zyron-node|unsafe-inline|\*/);
    if (shots) await page.screenshot({ path: join(shots, 'testnet-desktop.png'), fullPage: true });
    assert.deepEqual(errors, []);
  });

  await context.close();
} finally {
  await browser.close();
  server.close();
}
console.log(`testnet browser tests passed: ${passed}`);
