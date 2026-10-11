#!/usr/bin/env node
// Cross-engine smoke tests with Playwright WebKit (Safari engine) and Firefox: every site page and the Phone
// Wallet at phone and desktop widths (no overflow, no page errors), then the Phone Wallet create flow in WebKit
// emulating an iPhone, including installed standalone display mode (privacy gate, hidden words, no copy button,
// 4-word check before save, encrypted vault, update/build footer) and a signing review.
// Engines are optional locally: install with
//   node tools/pwa-wallet/node_modules/playwright-core/cli.js install webkit firefox  (+ install-deps)
// A missing engine is reported as "skip", never as a pass.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = join(repo, 'website');
const pw = createRequire(join(repo, 'tools', 'pwa-wallet', 'package.json'))('playwright-core');
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(site, path));
  if (!file.startsWith(site) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const PASSWORD = 'Correct-Horse-Battery-9';
let passed = 0; let skipped = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };

async function launch(name) {
  try { return await pw[name].launch(); } catch (error) { skipped += 1; console.log(`skip - ${name}: engine not installed (${String(error.message).split('\n')[0].slice(0, 80)})`); return null; }
}

try {
  for (const engine of ['webkit', 'firefox']) {
    const browser = await launch(engine);
    if (!browser) continue;
    try {
      await test(`${engine}: site pages and Phone Wallet render at 390 and 1440 px without overflow or errors`, async () => {
        for (const [w, h] of [[390, 844], [1440, 900]]) {
          const opts = { viewport: { width: w, height: h } };
          if (engine === 'webkit' && w < 600) Object.assign(opts, { isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
          const context = await browser.newContext(opts);
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(String(e)));
          for (const path of ['/', '/wallet.html', '/validator.html', '/privacy.html', '/terms.html', '/app/']) {
            await page.goto(base + path, { waitUntil: 'load' });
            const { sw, vw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
            assert.ok(sw <= vw, `${engine} ${path} @${w}: horizontal overflow ${sw} > ${vw}`);
          }
          assert.deepEqual(errors, [], `${engine} page errors @${w}`);
          await context.close();
        }
      });

      if (engine !== 'webkit') continue;
      await test('webkit (iPhone, standalone display mode): Phone Wallet create flow, hidden words, check before save, signing review', async () => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
        // Emulate an installed Home Screen app: display-mode standalone and navigator.standalone.
        await context.addInitScript(() => {
          const mm = window.matchMedia.bind(window);
          window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } : mm(q));
          Object.defineProperty(navigator, 'standalone', { get: () => true });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(base + '/app/', { waitUntil: 'load' });
        assert.match(await page.textContent('[data-build-id]'), /^Build [0-9a-f]{8} · release [0-9a-f]{8}$/);
        await page.tap('[data-go="create"]');
        await page.fill('[data-create-password]', PASSWORD);
        await page.fill('[data-create-password2]', PASSWORD);
        await page.tap('[data-create-next]');
        await page.waitForSelector('[data-screen="privacy"]:not([hidden])', { timeout: 120000 });
        assert.equal(await page.isDisabled('[data-privacy-next]'), true);
        await page.check('[data-privacy-ack]');
        await page.tap('[data-privacy-next]');
        await page.waitForSelector('[data-screen="phrase"]:not([hidden])');
        assert.deepEqual(await page.$$eval('[data-phrase-words] .word-text', (s) => s.map((x) => x.textContent)), Array(12).fill('•••••'));
        assert.equal(await page.$('[data-copy-phrase]'), null);
        if (shots) await page.screenshot({ path: join(shots, 'webkit-phrase-hidden.png') });
        const words = [];
        for (let i = 0; i < 12; i += 1) { await page.tap(`[data-word-index="${i}"]`); words.push(await page.textContent(`[data-word-index="${i}"] .word-text`)); }
        assert.ok(words.every((w) => /^[a-z]{3,8}$/.test(w)));
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await page.check('[data-phrase-ack]');
        await page.tap('[data-phrase-next]');
        const indexes = await page.$$eval('[data-quiz] input', (inputs) => inputs.map((i) => Number(i.dataset.quizIndex)));
        assert.equal(indexes.length, 4);
        const saved = () => page.evaluate(() => new Promise((r) => { const q = indexedDB.open('zyron-wallet-app'); q.onsuccess = () => { const db = q.result; const g = db.transaction('vault').objectStore('vault').getAll(); g.onsuccess = () => { r(g.result.length); db.close(); }; }; }));
        assert.equal(await saved(), 0, 'nothing saved before the check');
        for (const index of indexes) await page.fill(`[data-quiz-index="${index}"]`, words[index]);
        await page.tap('[data-quiz-check]');
        await page.waitForSelector('[data-screen="home"]:not([hidden])', { timeout: 120000 });
        assert.equal(await saved(), 1, 'encrypted vault saved after the check');
        assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);
        await page.fill('[data-tx-chain]', 'zyron-webkit-test');
        await page.fill('[data-tx-nonce]', '1');
        await page.fill('[data-tx-to]', 'ZYN16623f437e90cb7216ce70746f642717cc8b531f');
        await page.fill('[data-tx-amount]', '1');
        await page.fill('[data-tx-fee]', '0.00001');
        await page.tap('[data-tx-review]');
        await page.waitForSelector('[data-screen="review"]:not([hidden])');
        const labels = await page.$$eval('[data-review-rows] dt', (d) => d.map((x) => x.textContent));
        assert.deepEqual(labels, ['Type', 'From', 'To', 'Amount', 'Fee', 'Chain ID', 'Nonce', 'Timestamp']);
        assert.equal(await page.isDisabled('[data-tx-sign]'), true);
        if (shots) await page.screenshot({ path: join(shots, 'webkit-review.png') });
        assert.deepEqual(errors, []);
        await context.close();
      });
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
console.log(`engine tests passed: ${passed}, skipped engines: ${skipped}`);
