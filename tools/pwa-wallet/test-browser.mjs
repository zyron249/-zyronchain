#!/usr/bin/env node
// Headless Chrome tests for website/app (ZyronChain PWA wallet).
//   node tools/pwa-wallet/test-browser.mjs                         -> local server that mimics the Render/Cloudflare headers
//   node tools/pwa-wallet/test-browser.mjs --base https://zyronchain.com --shots /workspace/zyron-preview --prefix pwa
// Chrome: $CHROME_PATH or /usr/bin/google-chrome. Covers SW install + offline load, installability (Chrome's own
// installability check, the signal Lighthouse's retired PWA audit used), create/backup quiz/restore/lock/unlock/delete,
// QR content, clipboard auto-clear, transfer signing (validated against l1 when built), storage contents, network
// isolation, mobile layouts (360/390/414) and frame blocking.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const site = join(repo, 'website');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const shots = arg('--shots', '');
const prefix = arg('--prefix', 'pwa');
let base = arg('--base', '');
const live = Boolean(base);
const chromePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);
if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH');
if (shots) mkdirSync(shots, { recursive: true });

for (const file of ['website/app/vendor/noble-scure.js', 'website/app/vendor/qr.js', 'website/app/zyron-wallet-core.js']) vm.runInThisContext(readFileSync(join(repo, file), 'utf8'));
const core = globalThis.ZyronAppCore;
const SNAP = { mnemonic: 'test test test test test test test test test test test junk', address: 'ZYN0ac2dbccbd2a299dea4fcc2ddf98d7dd77eebb41' };
const PASSWORD = 'Correct-Horse-Battery-9';
const RECEIVER = 'ZYN5D99EE966b42cD8fC7bdD1364B389153A9E78B42'; // checksummed docs vector

// ---------- local server with the production response headers ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const PROD_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()',
  // Recommended (docs/WEBSITE_SECURITY_HEADERS.md); served here so the whole suite proves the wallet works with it.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'public, max-age=0, s-maxage=300'
};
let server = null;
let swTestSuffix = ''; // appended to sw.js to simulate a new deployment (update flow test)
if (!live) {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(site, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file.startsWith(site) || !existsSync(file)) { res.writeHead(404, PROD_HEADERS); return res.end('not found'); }
    res.writeHead(200, { ...PROD_HEADERS, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    // Emulate the CDN's lossless image re-encoding: PNG bytes differ from the repo (trailing bytes after IEND).
    if (file.endsWith(join('app', 'sw.js')) && swTestSuffix) return res.end(Buffer.concat([readFileSync(file), Buffer.from(swTestSuffix)]));
    res.end(extname(file) === '.png' ? Buffer.concat([readFileSync(file), Buffer.from('cdn-reencoded')]) : readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const appUrl = `${base}/app/index.html`;
const origin = new URL(base).origin;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const browser = await chromium.launch({ executablePath: chromePath });
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
async function newMobile(width = 390, height = 844, ua = ANDROID_UA, locale = 'en-US') {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: ua, locale, serviceWorkers: 'allow' });
  if (!live) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  const problems = [];
  const requests = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/.test(m.text())) problems.push('console: ' + m.text()); });
  context.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
  return { context, page, problems, requests };
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${prefix}-${name}.png`), fullPage: false }); };
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const visibleScreen = (page) => page.evaluate(() => document.body.dataset.current);

async function createWallet(page, { snapshot = false } = {}) {
  await page.click('[data-go="create"]');
  await page.fill('[data-create-password]', 'aaaaaaaaaaaaaaaa');
  await page.fill('[data-create-password2]', 'aaaaaaaaaaaaaaaa');
  await page.click('[data-create-next]');
  assert.match(await page.textContent('[data-strength]'), /weak|repetitive/i);
  await page.fill('[data-create-password]', PASSWORD);
  await page.fill('[data-create-password2]', PASSWORD + 'x');
  await page.click('[data-create-next]');
  assert.match(await page.textContent('[data-strength]'), /do not match/);
  await page.fill('[data-create-password2]', PASSWORD);
  if (snapshot) await shot(page, '2-create-password');
  await page.click('[data-create-next]');
  await page.waitForSelector('[data-screen="privacy"]:not([hidden])', { timeout: 60000 });
  assert.equal(await page.isDisabled('[data-privacy-next]'), true, 'cannot reveal before the privacy acknowledgement');
  assert.equal(await page.$$eval('[data-phrase-words] .word-card', (l) => l.length), 0, 'no word cards exist before the privacy screen is acknowledged');
  if (snapshot) await shot(page, '3a-privacy');
  await page.check('[data-privacy-ack]');
  await page.click('[data-privacy-next]');
  await page.waitForSelector('[data-screen="phrase"]:not([hidden])');
  const bip39 = new Set(globalThis.ZyronVendor.bip39.wordlist);
  const visibleWords = () => page.$$eval('[data-phrase-words] .word-text', (items) => items.map((s) => s.textContent));
  assert.deepEqual(await visibleWords(), Array(12).fill('•••••'), 'all words hidden by default');
  assert.match(await page.textContent('[data-phrase-words]'), /^(\d+•••••)+$/, 'the word list holds only numbers and placeholders before reveal');
  assert.ok((await page.$$eval('[data-phrase-words] [aria-label]', (b) => b.map((x) => x.getAttribute('aria-label')))).every((l) => /^Word \d+ of 12, hidden\./.test(l)), 'screen readers hear "hidden" with the word number');
  assert.equal(await page.$('[data-copy-phrase]'), null, 'no copy-phrase button');
  if (snapshot) await shot(page, '3b-phrase-hidden');
  // tap-to-reveal each card, collecting the words
  const words = [];
  for (let i = 0; i < 12; i += 1) {
    await page.click(`[data-word-index="${i}"]`);
    const word = await page.textContent(`[data-word-index="${i}"] .word-text`);
    assert.ok(bip39.has(word), `card ${i + 1} reveals a BIP-39 word`);
    assert.match(await page.getAttribute(`[data-word-index="${i}"]`, 'aria-label'), new RegExp(`^Word ${i + 1} of 12: `));
    words.push(word);
  }
  if (snapshot) await shot(page, '3c-phrase-revealed');
  // leaving the window hides everything
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.deepEqual(await visibleWords(), Array(12).fill('•••••'), 'blur hides all words');
  // hold-to-reveal-all shows words only while pressed
  const hold = await page.$('[data-hold-reveal]');
  const box = await hold.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  assert.deepEqual(await visibleWords(), words, 'hold reveals all words');
  await page.mouse.up();
  assert.deepEqual(await visibleWords(), Array(12).fill('•••••'), 'release hides all words');
  // auto-hide after inactivity
  await page.click('[data-word-index="0"]');
  assert.equal(await page.textContent('[data-word-index="0"] .word-text'), words[0]);
  await page.waitForFunction(() => document.querySelector('[data-word-index="0"] .word-text').textContent === '•••••', null, { timeout: 25000 });
  assert.equal(await page.isDisabled('[data-phrase-next]'), true, 'cannot continue before acknowledging');
  await page.check('[data-phrase-ack]');
  await page.click('[data-phrase-next]');
  assert.equal(await page.$$eval('[data-phrase-words] li', (l) => l.length), 0, 'words leave the DOM during the quiz');
  const indexes = await page.$$eval('[data-quiz] input', (inputs) => inputs.map((i) => Number(i.dataset.quizIndex)));
  assert.equal(indexes.length, 4, 'four-word backup check');
  assert.equal(new Set(indexes).size, 4);
  // wrong answers first: nothing may be saved
  for (const index of indexes) await page.fill(`[data-quiz-index="${index}"]`, 'zoo');
  await page.click('[data-quiz-check]');
  assert.match(await page.textContent('[data-quiz-result]'), /wrong/);
  assert.equal(await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('zyron-wallet-app'); q.onsuccess = () => { const db = q.result; const g = db.transaction('vault').objectStore('vault').get('primary'); g.onsuccess = () => { r(g.result === undefined); db.close(); }; }; })), true, 'vault not saved before the quiz passes');
  for (const index of indexes) await page.fill(`[data-quiz-index="${index}"]`, ` ${words[index].toUpperCase()} `);
  if (snapshot) await shot(page, '4-backup-quiz');
  await page.click('[data-quiz-check]');
  await page.waitForSelector('[data-screen="home"]:not([hidden])');
  assert.equal(await page.isVisible('[data-created-note]'), true);
  assert.equal(await page.$$eval('[data-phrase-words] li, [data-quiz] input', (l) => l.length), 0, 'phrase cards and check inputs are gone after saving');
  return words;
}
async function readVaultRecord(page) {
  return page.evaluate(() => new Promise((resolveRecord, reject) => {
    const q = indexedDB.open('zyron-wallet-app');
    q.onerror = () => reject(q.error);
    q.onsuccess = () => { const db = q.result; const g = db.transaction('vault').objectStore('vault').getAll(); g.onsuccess = () => { resolveRecord(g.result); db.close(); }; };
  }));
}

try {
  let l1 = null;
  const l1Dist = join(repo, 'l1', 'dist', 'src');
  if (existsSync(join(l1Dist, 'transaction.js'))) l1 = await import(pathToFileURL(join(l1Dist, 'transaction.js')).href);

  const { context, page, problems, requests } = await newMobile();
  await test('first load: no errors, same-origin GETs only, installable per Chrome, iOS/Android install help shown', async () => {
    await page.goto(appUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.current === 'welcome');
    assert.equal(await page.title(), 'ZyronChain Wallet (testnet)');
    await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((_, reject) => setTimeout(() => reject(new Error('service worker did not install within 45 s')), 45000))]));
    // Playwright contexts are incognito (never installable), so installability is checked in a real profile.
    const profile = mkdtempSync(join(tmpdir(), 'zyron-pwa-profile-'));
    const persistent = await chromium.launchPersistentContext(profile, { executablePath: chromePath, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: ANDROID_UA });
    try {
      const p = persistent.pages()[0] || await persistent.newPage();
      await p.goto(appUrl, { waitUntil: 'load' });
      await p.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((_, reject) => setTimeout(() => reject(new Error('service worker did not install within 45 s')), 45000))]));
      const cdp = await persistent.newCDPSession(p);
      const manifest = await cdp.send('Page.getAppManifest');
      assert.deepEqual(manifest.errors, [], 'manifest parse errors');
      assert.match(manifest.url, /\/app\/manifest\.json$/);
      let installability = [];
      for (let i = 0; i < 20; i += 1) { installability = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors; if (!installability.length) break; await p.waitForTimeout(500); }
      assert.deepEqual(installability, [], 'Chrome installability errors: ' + JSON.stringify(installability));
    } finally {
      await persistent.close();
      rmSync(profile, { recursive: true, force: true });
    }
    assert.ok(await page.isVisible('[data-platform="android"]'));
    assert.ok(await noHorizontalScroll(page));
    await page.locator('[data-install]').scrollIntoViewIfNeeded();
    await shot(page, '1-install-instructions');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, '1-welcome');
  });

  await test('service worker: versioned cache holds exactly the app shell; offline reload works', async () => {
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const out = {};
      for (const key of keys) out[key] = (await (await caches.open(key)).keys()).map((r) => new URL(r.url).pathname).sort();
      return out;
    });
    const names = Object.keys(cached);
    assert.equal(names.length, 1);
    assert.match(names[0], /^zyron-wallet-app-[0-9a-f]{16}$/);
    const sw = readFileSync(join(site, 'app', 'sw.js'), 'utf8');
    if (!live) assert.ok(names[0].endsWith(sw.match(/const VERSION = '([0-9a-f]{16})'/)[1]));
    const cachedUrls = await page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => { const u = new URL(r.url); return u.pathname + u.search; }).sort(), names[0]);
    const shellKeys = Object.keys(JSON.parse(sw.match(/const ASSETS = (\{[\s\S]*?\});/)[1])).map((k) => '/app/' + k.slice(2)).sort();
    if (!live) assert.deepEqual(cachedUrls, shellKeys, 'cache holds exactly the stamped shell URLs');
    for (const file of ['app.js', 'app.css', 'zyron-wallet-core.js', 'vendor/noble-scure.js', 'vendor/qr.js']) assert.ok(cachedUrls.some((u) => new RegExp(`^/app/${file.replace('.', '\\.')}\\?v=[0-9a-f]{12}$`).test(u)), `${file} cached under its versioned URL`);
    assert.deepEqual(cached[names[0]].filter((p) => !/\.(js|css)$/.test(p)), ['/app/icons/apple-touch-icon-180.png', '/app/icons/icon-192.png', '/app/icons/maskable-192.png', '/app/index.html', '/app/manifest.json'].sort());
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.current === 'welcome' && !!globalThis.ZyronAppCore && !!globalThis.ZyronQR);
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
    const offlineNav = await context.newPage();
    await offlineNav.goto(`${base}/app/`, { waitUntil: 'load' });
    assert.equal(await offlineNav.title(), 'ZyronChain Wallet (testnet)', '/app/ also opens offline');
    await offlineNav.close();
    await context.setOffline(false);
    const noSlash = await context.newPage();
    await noSlash.goto(`${base}/app`, { waitUntil: 'load' });
    await noSlash.waitForFunction(() => !!globalThis.ZyronAppCore && document.body.dataset.current === 'welcome');
    await noSlash.close();
    await context.setOffline(true);
  });

  await test('build id is shown and matches the stamped worker version and release', async () => {
    const sw = readFileSync(join(site, 'app', 'sw.js'), 'utf8');
    const version = sw.match(/const VERSION = '([0-9a-f]{16})'/)[1];
    const release = readFileSync(join(site, 'release.js'), 'utf8').match(/const RELEASE_REF = '([0-9a-f]{40})'/)[1];
    const text = await page.textContent('[data-build-id]');
    if (!live) assert.equal(text, `Build ${version.slice(0, 8)} · release ${release.slice(0, 8)}`);
    else assert.match(text, /^Build [0-9a-f]{8} · release [0-9a-f]{8}$/);
  });

  let words;
  let address;
  await test('create (offline): password rules, phrase shown once, forced backup quiz, encrypted vault only', async () => {
    const before = requests.length;
    words = await createWallet(page, { snapshot: true });
    const entropy = core.phraseToEntropy(words.join(' '));
    address = (await core.deriveAccount(entropy)).address;
    assert.equal(await page.textContent('[data-home-address]'), core.groupAddress(core.toChecksumAddress(address)));
    const records = await readVaultRecord(page);
    assert.equal(records.length, 1);
    const vault = records[0];
    core.assertVaultShape(vault);
    assert.equal(vault.address, address);
    const text = JSON.stringify(vault);
    for (const secret of [...words.filter((w) => w.length > 4), core.wipe ? Buffer.from(entropy).toString('hex') : '', PASSWORD]) if (secret) assert.ok(!text.includes(secret), 'vault leaks a secret');
    const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, dbs: (await indexedDB.databases()).map((d) => d.name), cookie: document.cookie }));
    assert.deepEqual(storage, { local: 0, session: 0, dbs: ['zyron-wallet-app'], cookie: '' });
    assert.equal(requests.slice(before).filter((r) => r.url.startsWith('http')).length, 0, 'no network requests while creating (offline + CSP)');
  });
  await context.setOffline(false);

  await test('home: checksummed address, QR encodes the plain address, clipboard copy auto-clears', async () => {
    const qrPath = await page.getAttribute('[data-qr] path', 'd');
    const size = Number((await page.getAttribute('[data-qr] svg', 'viewBox')).split(' ')[2]);
    const expected = globalThis.ZyronQR.encodeQR(address, 'raw', { ecc: 'medium', border: 2 });
    let d = '';
    for (let y = 0; y < expected.length; y += 1) for (let x = 0; x < expected.length; x += 1) if (expected[y][x]) d += 'M' + x + ' ' + y + 'h1v1h-1z';
    assert.equal(size, expected.length);
    assert.equal(qrPath, d, 'QR matrix encodes the canonical address');
    await shot(page, '5-home-qr');
    if (!live) {
      await page.clock.install();
      await page.click('[data-copy-address]');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), core.toChecksumAddress(address));
      assert.equal(await page.textContent('[data-copy-result]'), 'Copied. Clipboard will be cleared automatically.');
      await page.clock.fastForward(61000);
      await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t === ''));
    }
  });

  let signed;
  await test('sign transfer offline: exact l1 transfer, no network, broadcast disabled', async () => {
    assert.equal(await page.isDisabled('[data-screen="home"] button[disabled]'), true);
    const before = requests.length;
    await page.fill('[data-tx-chain]', 'zyron-pwa-test');
    await page.fill('[data-tx-nonce]', '1');
    await page.fill('[data-tx-to]', RECEIVER);
    assert.match(await page.textContent('[data-tx-check]'), /checksum verified/);
    await page.fill('[data-tx-amount]', '2.5');
    await page.fill('[data-tx-fee]', '0.00001');
    await page.click('[data-tx-review]');
    await page.waitForSelector('[data-screen="review"]:not([hidden])');
    const rows = await page.$$eval('[data-review-rows] > div', (divs) => divs.map((d) => [d.dataset.reviewKey, d.querySelector('dt').textContent, d.querySelector('dd').textContent]));
    assert.deepEqual(rows.map((r) => r[1]), ['Type', 'From', 'To', 'Amount', 'Fee', 'Chain ID', 'Nonce', 'Timestamp']);
    const review = Object.fromEntries(rows.map((r) => [r[0], r[2]]));
    assert.equal(review.from, core.toChecksumAddress(address));
    assert.equal(review.to, RECEIVER);
    assert.equal(review.amount, '2.5 ZYN (250000000 atoms)');
    assert.equal(review.fee, '0.00001 ZYN (1000 atoms)');
    assert.equal(review.chain, 'zyron-pwa-test');
    assert.equal(review.nonce, '1');
    assert.match(review.type, /Transfer \(kind "transfer", version 2\)/);
    assert.equal(await page.isDisabled('[data-tx-sign]'), true, 'signing needs a deliberate confirmation');
    assert.equal(await page.isVisible('[data-tx-out]'), false, 'nothing is signed on review');
    await shot(page, '6a-review-transfer');
    await page.check('[data-review-ack]');
    await page.click('[data-tx-sign]');
    await page.waitForSelector('[data-tx-out]:not([hidden])');
    assert.match(await page.textContent('[data-tx-summary]'), /Signed locally\. Not broadcast\./);
    signed = JSON.parse(await page.textContent('[data-tx-json]'));
    assert.equal(signed.kind, 'transfer');
    assert.equal(signed.version, 2);
    assert.equal(signed.sender, address);
    assert.equal(signed.receiver, RECEIVER.toLowerCase().replace('zyn', 'ZYN'));
    assert.equal(signed.amountAtoms, 250000000);
    assert.equal(signed.feeAtoms, 1000);
    if (l1) l1.validateTransactionShape(signed);
    assert.ok(core.verifyCanonical({ domain: core.TRANSFER_SIGNING_DOMAIN_V2, payload: (({ signature, txid, ...rest }) => rest)(signed) }, signed.signature, signed.publicKey));
    await page.locator('[data-tx-out]').scrollIntoViewIfNeeded();
    await shot(page, '6-sign-transfer');
    const download = page.waitForEvent('download');
    await page.click('[data-tx-download]');
    assert.match((await download).suggestedFilename(), /^zyron-transfer-nonce-1\.json$/);
    assert.equal(requests.slice(before).filter((r) => r.url.startsWith('http')).length, 0, 'signing makes no requests');
    await page.click('[data-review-done]');
    await page.waitForSelector('[data-screen="home"]:not([hidden])');
    await page.fill('[data-tx-to]', core.MINING_TRACKER_ADDRESS);
    await page.click('[data-tx-review]');
    assert.match(await page.textContent('[data-tx-check]'), /mining tracker/);
    assert.equal(await visibleScreen(page), 'home', 'invalid transfers never reach the review screen');
    await page.fill('[data-tx-to]', RECEIVER);
    await page.fill('[data-tx-chain]', '');
    await page.click('[data-tx-review]');
    assert.match(await page.textContent('[data-tx-check]'), /Chain ID/, 'missing chain parameters are not guessed');
  });

  await test('lock / wrong password / unlock / auto-lock after inactivity', async () => {
    await page.click('[data-lock]');
    assert.equal(await visibleScreen(page), 'unlock');
    assert.equal(await page.$$eval('[data-tx-json]', (n) => n[0].textContent), '', 'signed output cleared on lock');
    await page.fill('[data-unlock-password]', PASSWORD + 'nope');
    await page.click('[data-unlock-go]');
    await page.waitForFunction(() => /Wrong password|modified/.test(document.querySelector('[data-unlock-result]').textContent), null, { timeout: 60000 });
    assert.match(await page.textContent('[data-unlock-result]'), /Wrong password/);
    await page.fill('[data-unlock-password]', PASSWORD);
    await page.click('[data-unlock-go]');
    await page.waitForSelector('[data-screen="home"]:not([hidden])', { timeout: 60000 });
    if (!live) {
      await page.clock.fastForward(5 * 60 * 1000 + 1000);
      await page.waitForFunction(() => document.body.dataset.current === 'unlock');
    }
  });

  await test('tampered vault in IndexedDB is refused on unlock', async () => {
    await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('zyron-wallet-app'); q.onsuccess = () => { const db = q.result; const s = db.transaction('vault', 'readwrite').objectStore('vault'); const g = s.get('primary'); g.onsuccess = () => { const v = g.result; v.ciphertext = (v.ciphertext[0] === '0' ? '1' : '0') + v.ciphertext.slice(1); s.put(v, 'primary').onsuccess = () => { db.close(); r(); }; }; }; }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.current === 'unlock');
    await page.fill('[data-unlock-password]', PASSWORD);
    await page.click('[data-unlock-go]');
    await page.waitForFunction(() => /Wrong password|modified/.test(document.querySelector('[data-unlock-result]').textContent), null, { timeout: 60000 });
    assert.match(await page.textContent('[data-unlock-result]'), /Wrong password|modified/);
  });

  await test('delete wallet: confirmation screen, acknowledgement + typing DELETE, then the vault is gone', async () => {
    await page.click('[data-screen="unlock"] summary');
    await page.click('[data-screen="unlock"] [data-go="delete"]');
    assert.equal(await page.isDisabled('[data-delete-go]'), true);
    assert.match(await page.textContent('[data-screen="delete"]'), /removes the local encrypted vault from this application's storage on this device/);
    assert.match(await page.textContent('[data-screen="delete"]'), /may be permanently lost/);
    assert.doesNotMatch(await page.textContent('[data-screen="delete"]'), /securely (erase|overwrite|wipe)s?\b(?! of)/i);
    await page.fill('[data-delete-confirm]', 'delete');
    assert.equal(await page.isDisabled('[data-delete-go]'), true, 'typing alone is not enough');
    await page.check('[data-delete-ack]');
    assert.equal(await page.isDisabled('[data-delete-go]'), false);
    await page.click('[data-delete-go]');
    await page.waitForFunction(() => document.body.dataset.current === 'welcome');
    assert.deepEqual(await readVaultRecord(page), []);
  });

  await test('restore from the Snap test phrase gives the Snap address (English-only UI)', async () => {
    assert.equal(await page.getAttribute('html', 'lang'), 'en');
    assert.equal(await page.$('[data-lang-toggle]'), null, 'no language toggle');
    assert.match(await page.textContent('[data-go="create"]'), /Create a new wallet|new wallet/i);
    await page.click('[data-go="restore"]');
    await page.fill('[data-restore-phrase]', 'test test test test test test test test test test test jun');
    await page.fill('[data-restore-password]', PASSWORD);
    await page.fill('[data-restore-password2]', PASSWORD);
    await page.click('[data-restore-go]');
    assert.match(await page.textContent('[data-restore-result]'), /word list|Error/);
    await page.fill('[data-restore-phrase]', SNAP.mnemonic);
    await page.click('[data-restore-go]');
    await page.waitForSelector('[data-screen="home"]:not([hidden])', { timeout: 60000 });
    assert.equal(await page.textContent('[data-home-address]'), core.groupAddress(core.toChecksumAddress(SNAP.address)));
    await shot(page, '7-home-restored');
  });

  await test('stored vault with an unknown version or malformed data is rejected and left untouched (fail closed)', async () => {
    const original = (await readVaultRecord(page))[0];
    for (const bad of [{ ...original, version: 2 }, { ...original, kdf: { ...original.kdf, n: 1024 } }, 'garbage']) {
      await page.evaluate((value) => new Promise((r) => { const q = indexedDB.open('zyron-wallet-app'); q.onsuccess = () => { const db = q.result; db.transaction('vault', 'readwrite').objectStore('vault').put(value, 'primary').onsuccess = () => { db.close(); r(); }; }; }), bad);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !document.querySelector('[data-unsupported]').hidden);
      assert.match(await page.textContent('[data-unsupported]'), /stored vault was rejected and left untouched/);
      assert.equal(await page.isDisabled('[data-go="create"]'), true, 'cannot overwrite a rejected vault by creating a new one');
      assert.deepEqual(await readVaultRecord(page), [bad], 'rejected vault is not rewritten');
    }
    await page.click('[data-rejected-delete]');
    await page.check('[data-delete-ack]');
    await page.fill('[data-delete-confirm]', 'DELETE');
    await page.click('[data-delete-go]');
    await page.waitForFunction(() => document.body.dataset.current === 'welcome');
    assert.deepEqual(await readVaultRecord(page), []);
    assert.equal(await page.isDisabled('[data-go="create"]'), false);
    assert.equal(await page.isVisible('[data-unsupported]'), false);
  });

  await test('missing crypto libraries: the wallet refuses to run', async () => {
    const m = await newMobile();
    await m.page.route(/\/app\/vendor\/noble-scure\.js(\?|$)/, (route) => route.fulfill({ status: 404, body: 'gone' }));
    await m.page.goto(appUrl, { waitUntil: 'load' });
    await m.page.waitForFunction(() => !document.querySelector('[data-unsupported]').hidden);
    assert.match(await m.page.textContent('[data-unsupported]'), /refuses to run/);
    assert.equal(await m.page.isDisabled('[data-go="create"]'), true);
    assert.equal(await m.page.isDisabled('[data-go="restore"]'), true);
    await m.context.close();
  });
  assert.deepEqual(problems, [], 'console/page errors');
  const foreign = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('blob:') && !r.url.startsWith('data:'));
  assert.deepEqual(foreign, [], 'no third-party requests');
  assert.ok(requests.every((r) => r.method === 'GET'), 'GET requests only');
  await context.close();

  if (!live) await test('update flow: a new worker waits, "Update now" activates it and reloads; deferred during wallet creation', async () => {
    const m = await newMobile();
    await m.page.goto(appUrl, { waitUntil: 'load' });
    await m.page.evaluate(() => navigator.serviceWorker.ready);
    await m.page.reload({ waitUntil: 'load' });
    await m.page.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.equal(await m.page.isVisible('[data-update-banner]'), false, 'no banner without an update');
    const firstScript = await m.page.evaluate(() => navigator.serviceWorker.controller.scriptURL);
    swTestSuffix = '\n// simulated deployment ' + Date.now() + '\n';
    try {
      await m.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
      await m.page.waitForSelector('[data-update-banner]:not([hidden])', { timeout: 30000 });
      assert.equal(await m.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r.waiting)), true, 'new worker is waiting, not forced in');
      assert.match(await m.page.textContent('[data-update-banner]'), /A new Zyron Wallet version is available\./);
      await shot(m.page, '8-update-available');
      // During wallet creation the update is deferred (it would reload and drop the pending flow).
      await m.page.click('[data-go="create"]');
      await m.page.fill('[data-create-password]', PASSWORD);
      await m.page.fill('[data-create-password2]', PASSWORD);
      await m.page.click('[data-create-next]');
      await m.page.waitForSelector('[data-screen="privacy"]:not([hidden])', { timeout: 60000 });
      await m.page.click('[data-update-now]');
      assert.equal(await m.page.isVisible('[data-update-hint]'), true);
      assert.equal(await m.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r.waiting)), true, 'still waiting');
      await m.page.click('[data-screen="privacy"] [data-cancel-create]');
      const reloaded = m.page.waitForEvent('load');
      await m.page.click('[data-update-now]');
      await reloaded;
      await m.page.waitForFunction(() => document.body.dataset.current === 'welcome' && !!navigator.serviceWorker.controller);
      assert.equal(await m.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !r.waiting && !!r.active)), true, 'new worker active');
      assert.equal(await m.page.isVisible('[data-update-banner]'), false);
      assert.equal(await m.page.evaluate(() => navigator.serviceWorker.controller.scriptURL), firstScript);
      assert.equal((await m.page.evaluate(() => caches.keys())).length, 1, 'old cache removed on activate');
    } finally {
      swTestSuffix = '';
    }
    await m.context.close();
  });

  await test('mobile layouts 360/390/414: no horizontal scroll on every screen; iOS shows Safari steps first', async () => {
    for (const width of [360, 390, 414]) {
      const m = await newMobile(width, 800, width === 390 ? IOS_UA : ANDROID_UA);
      await m.page.goto(appUrl, { waitUntil: 'load' });
      await m.page.waitForFunction(() => document.body.dataset.current === 'welcome');
      if (width === 390) {
        assert.equal(await m.page.$eval('.install-steps', (el) => el.firstElementChild.dataset.platform), 'ios');
        await m.page.locator('[data-install]').scrollIntoViewIfNeeded();
        await shot(m.page, '1-install-ios');
      }
      for (const screen of ['welcome', 'create', 'privacy', 'phrase', 'quiz', 'restore', 'review', 'delete']) {
        await m.page.evaluate((name) => { for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== name; }, screen);
        assert.ok(await noHorizontalScroll(m.page), `${width}px ${screen}`);
      }
      await m.page.evaluate(() => { for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== 'home'; document.querySelector('[data-home-address]').textContent = 'ZYN 09C0 B2D1 A486 C439 A87b CbA6 b46A 7a1A 23F3 897c'; document.querySelector('[data-tx-out]').hidden = false; document.querySelector('[data-tx-json]').textContent = JSON.stringify({ kind: 'transfer', publicKey: 'ab'.repeat(64), signature: 'cd'.repeat(64) }, null, 2); });
      assert.ok(await noHorizontalScroll(m.page), `${width}px home`);
      assert.deepEqual(m.problems, []);
      await m.context.close();
    }
  });

  await test('framing is blocked (header frame-ancestors + in-app guard)', async () => {
    const m = await newMobile();
    await m.page.goto(`${base}/app/manifest.json`);
    await m.page.setContent(`<iframe src="${appUrl}" width="390" height="600"></iframe>`);
    await m.page.waitForTimeout(1500);
    const frame = m.page.frames()[1];
    const rendered = frame ? await frame.evaluate(() => !!document.querySelector('[data-screen]') && getComputedStyle(document.documentElement).display !== 'none').catch(() => false) : false;
    assert.equal(rendered, false);
    await m.context.close();
  });
} finally {
  await browser.close();
  if (server) server.close();
}
console.log(`pwa-browser tests passed: ${passed}${live ? ` (live ${base})` : ''}`);
