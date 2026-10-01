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
  'Cache-Control': 'public, max-age=0, s-maxage=300'
};
let server = null;
if (!live) {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(site, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file.startsWith(site) || !existsSync(file)) { res.writeHead(404, PROD_HEADERS); return res.end('not found'); }
    res.writeHead(200, { ...PROD_HEADERS, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
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
  assert.match(await page.textContent('[data-strength]'), /weak|repetitive|zayıf/i);
  await page.fill('[data-create-password]', PASSWORD);
  await page.fill('[data-create-password2]', PASSWORD + 'x');
  await page.click('[data-create-next]');
  assert.match(await page.textContent('[data-strength]'), /do not match|eşleşmiyor/);
  await page.fill('[data-create-password2]', PASSWORD);
  if (snapshot) await shot(page, '2-create-password');
  await page.click('[data-create-next]');
  await page.waitForSelector('[data-screen="phrase"]:not([hidden])', { timeout: 60000 });
  const words = await page.$$eval('[data-phrase-words] li', (items) => items.map((li) => li.textContent));
  assert.equal(words.length, 12);
  assert.equal(await page.isDisabled('[data-phrase-next]'), true, 'cannot continue before acknowledging');
  if (snapshot) await shot(page, '3-phrase-backup');
  await page.check('[data-phrase-ack]');
  await page.click('[data-phrase-next]');
  assert.equal(await page.$$eval('[data-phrase-words] li', (l) => l.length), 0, 'words leave the DOM during the quiz');
  const indexes = await page.$$eval('[data-quiz] input', (inputs) => inputs.map((i) => Number(i.dataset.quizIndex)));
  assert.equal(indexes.length, 3);
  // wrong answers first: nothing may be saved
  for (const index of indexes) await page.fill(`[data-quiz-index="${index}"]`, 'zoo');
  await page.click('[data-quiz-check]');
  assert.match(await page.textContent('[data-quiz-result]'), /wrong|yanlış/);
  assert.equal(await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('zyron-wallet-app'); q.onsuccess = () => { const db = q.result; const g = db.transaction('vault').objectStore('vault').get('primary'); g.onsuccess = () => { r(g.result === undefined); db.close(); }; }; })), true, 'vault not saved before the quiz passes');
  for (const index of indexes) await page.fill(`[data-quiz-index="${index}"]`, ` ${words[index].toUpperCase()} `);
  if (snapshot) await shot(page, '4-backup-quiz');
  await page.click('[data-quiz-check]');
  await page.waitForSelector('[data-screen="home"]:not([hidden])');
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
    await page.evaluate(() => navigator.serviceWorker.ready);
    // Playwright contexts are incognito (never installable), so installability is checked in a real profile.
    const profile = mkdtempSync(join(tmpdir(), 'zyron-pwa-profile-'));
    const persistent = await chromium.launchPersistentContext(profile, { executablePath: chromePath, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: ANDROID_UA });
    try {
      const p = persistent.pages()[0] || await persistent.newPage();
      await p.goto(appUrl, { waitUntil: 'load' });
      await p.evaluate(() => navigator.serviceWorker.ready);
      const cdp = await persistent.newCDPSession(p);
      const manifest = await cdp.send('Page.getAppManifest');
      assert.deepEqual(manifest.errors, [], 'manifest parse errors');
      assert.match(manifest.url, /\/app\/manifest\.webmanifest$/);
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
    assert.deepEqual(cached[names[0]], ['/app/apple-touch-icon-180.png', '/app/icons/icon-192.png', '/app/icons/maskable-192.png', '/app/app.css', '/app/app.js', '/app/index.html', '/app/manifest.webmanifest', '/app/vendor/noble-scure.js', '/app/vendor/qr.js', '/app/zyron-wallet-core.js'].map((p) => p.replace('/app/apple', '/app/icons/apple')).sort());
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.current === 'welcome' && !!globalThis.ZyronAppCore && !!globalThis.ZyronQR);
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
    const offlineNav = await context.newPage();
    await offlineNav.goto(`${base}/app/`, { waitUntil: 'load' });
    assert.equal(await offlineNav.title(), 'ZyronChain Wallet (testnet)', '/app/ also opens offline');
    await offlineNav.close();
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
    assert.match(await page.textContent('[data-tx-check]'), /checksum verified|doğrulandı/);
    await page.fill('[data-tx-amount]', '2.5');
    await page.fill('[data-tx-fee]', '0.00001');
    await page.click('[data-tx-sign]');
    await page.waitForSelector('[data-tx-out]:not([hidden])');
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
    await page.fill('[data-tx-to]', core.MINING_TRACKER_ADDRESS);
    await page.click('[data-tx-sign]');
    assert.match(await page.textContent('[data-tx-check]'), /mining tracker/);
  });

  await test('lock / wrong password / unlock / auto-lock after inactivity', async () => {
    await page.click('[data-lock]');
    assert.equal(await visibleScreen(page), 'unlock');
    assert.equal(await page.$$eval('[data-tx-json]', (n) => n[0].textContent), '', 'signed output cleared on lock');
    await page.fill('[data-unlock-password]', PASSWORD + 'nope');
    await page.click('[data-unlock-go]');
    await page.waitForFunction(() => /Wrong password|modified|Şifre yanlış/.test(document.querySelector('[data-unlock-result]').textContent), null, { timeout: 60000 });
    assert.match(await page.textContent('[data-unlock-result]'), /Wrong password|Şifre yanlış/);
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
    await page.waitForFunction(() => /Wrong password|modified|Şifre yanlış/.test(document.querySelector('[data-unlock-result]').textContent), null, { timeout: 60000 });
    assert.match(await page.textContent('[data-unlock-result]'), /Wrong password|modified|Şifre yanlış/);
  });

  await test('delete wallet requires typing DELETE, then the vault is gone', async () => {
    await page.click('[data-screen="unlock"] summary');
    await page.click('[data-screen="unlock"] [data-go="delete"]');
    assert.equal(await page.isDisabled('[data-delete-go]'), true);
    await page.fill('[data-delete-confirm]', 'delete');
    assert.equal(await page.isDisabled('[data-delete-go]'), false);
    await page.click('[data-delete-go]');
    await page.waitForFunction(() => document.body.dataset.current === 'welcome');
    assert.deepEqual(await readVaultRecord(page), []);
  });

  await test('restore from the Snap test phrase gives the Snap address (Turkish UI)', async () => {
    await page.click('[data-lang-toggle]');
    assert.equal(await page.getAttribute('html', 'lang'), 'tr');
    assert.match(await page.textContent('[data-go="create"]'), /Yeni cüzdan/);
    await page.click('[data-go="restore"]');
    await page.fill('[data-restore-phrase]', 'test test test test test test test test test test test jun');
    await page.fill('[data-restore-password]', PASSWORD);
    await page.fill('[data-restore-password2]', PASSWORD);
    await page.click('[data-restore-go]');
    assert.match(await page.textContent('[data-restore-result]'), /word list|Hata/);
    await page.fill('[data-restore-phrase]', SNAP.mnemonic);
    await page.click('[data-restore-go]');
    await page.waitForSelector('[data-screen="home"]:not([hidden])', { timeout: 60000 });
    assert.equal(await page.textContent('[data-home-address]'), core.groupAddress(core.toChecksumAddress(SNAP.address)));
    await shot(page, '7-home-turkish');
  });
  assert.deepEqual(problems, [], 'console/page errors');
  const foreign = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('blob:') && !r.url.startsWith('data:'));
  assert.deepEqual(foreign, [], 'no third-party requests');
  assert.ok(requests.every((r) => r.method === 'GET'), 'GET requests only');
  await context.close();

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
      for (const screen of ['welcome', 'create', 'restore', 'delete']) {
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
    await m.page.goto(`${base}/app/manifest.webmanifest`);
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
