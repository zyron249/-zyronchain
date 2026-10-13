#!/usr/bin/env node
// Headless-Chrome checks for ZYRON HUB: layout at phone/tablet/desktop widths (sidebar vs bottom nav), keyboard
// navigation, no console errors, honest rendering of the two status reads (served from fixtures, never the
// network), and graceful fallbacks when the services are down. Uses the pinned playwright-core from tools/pwa-wallet.
//   CHROME_PATH=/usr/bin/google-chrome node tools/site/test-hub-browser.mjs [--shots <dir>]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = join(repo, 'website');
const { chromium } = createRequire(join(repo, 'tools', 'pwa-wallet', 'package.json'))('playwright-core');
const chromePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(site, p));
  if (!file.startsWith(site) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/hub/`;
const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };

const META = { name: 'ZYRON NODE', clientBuild: 'fixture.1', season: { id: 1, name: 'Season 0', status: 'active' }, pointsNotice: 'Zyron Points are off-chain gameplay points.' };
const STATUS = { network: 'testnet', valueBearing: false, chainId: 'zyron-wallet-testnet-1', height: 42, genesisHash: 'ab'.repeat(32), notice: 'Test ZYN has no value.' };
const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
async function open(viewport, { meta = META, status = STATUS, fail = false } = {}) {
  const mobile = viewport.width < 760;
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  // Every other external request is blocked, so the test can never reach a real service.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    const u = route.request().url();
    if (fail) return route.fulfill({ status: 503, headers: cors, body: '{}' });
    if (u === 'https://zyron-node.onrender.com/api/meta') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(meta) });
    if (u === 'https://zyron-wallet-testnet-rpc.onrender.com/status') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(status) });
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/503/.test(m.text())) errors.push(m.text()); });
  return { context, page, errors };
}

try {
  await test('layout: no horizontal overflow, sidebar on desktop, bottom nav on phones, no console errors', async () => {
    for (const [w, h] of [[320, 640], [375, 812], [390, 844], [768, 1024], [1024, 768], [1440, 900]]) {
      const { context, page, errors } = await open({ width: w, height: h });
      for (const hash of ['#overview', '#network', '#staking']) {
        await page.goto(base + hash, { waitUntil: 'load' });
        await page.waitForSelector('[data-out="rpc-status"] .state-ok', { state: 'attached' });
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, nav: getComputedStyle(document.querySelector('.hub-nav')).position, navBottom: document.querySelector('.hub-nav').getBoundingClientRect().bottom, vh: innerHeight }));
        assert.ok(m.sw <= m.vw, `${hash} @${w}: horizontal scroll ${m.sw} > ${m.vw}`);
        if (w <= 720) { assert.equal(m.nav, 'fixed', `bottom nav @${w}`); assert.ok(Math.abs(m.navBottom - m.vh) <= 1, `nav pinned to bottom @${w}`); }
        else assert.equal(m.nav, 'sticky', `sidebar @${w}`);
        if (shots && hash === '#overview' && (w === 390 || w === 1440)) await page.screenshot({ path: join(shots, `hub-${w === 390 ? 'mobile' : 'desktop'}.png`), fullPage: true });
        if (shots && hash === '#network' && (w === 390 || w === 1440)) await page.screenshot({ path: join(shots, `hub-network-${w === 390 ? 'mobile' : 'desktop'}.png`), fullPage: true });
      }
      assert.deepEqual(errors, [], `console errors @${w}`);
      await context.close();
    }
  });

  await test('status reads render real fields via text only; one module visible at a time', async () => {
    const { context, page } = await open({ width: 1440, height: 900 }, { meta: { ...META, clientBuild: '<img src=x onerror=alert(1)>' } });
    await page.goto(base + '#node', { waitUntil: 'load' });
    await page.waitForSelector('[data-out="game-meta"] .state-ok', { state: 'attached' });
    assert.equal(await page.locator('[data-out="game-meta"] img').count(), 0, 'remote text must never become markup');
    assert.match(await page.textContent('[data-out="game-meta"]'), /<img src=x/);
    assert.equal(await page.locator('[data-section]:visible').count(), 1);
    await page.goto(base + '#network');
    await page.waitForSelector('[data-out="rpc-status"] .state-ok', { state: 'attached' });
    const net = await page.textContent('[data-out="rpc-status"]');
    assert.match(net, /zyron-wallet-testnet-1/); assert.match(net, /42/); assert.match(net, /valueBearing: false/);
    await context.close();
  });

  await test('refuses a status that does not declare valueBearing: false; services down show reasons', async () => {
    let r = await open({ width: 390, height: 844 }, { status: { ...STATUS, valueBearing: true } });
    await r.page.goto(base + '#network', { waitUntil: 'load' });
    await r.page.waitForSelector('[data-out="rpc-status"] .state-warn', { state: 'attached' });
    assert.doesNotMatch(await r.page.textContent('[data-out="rpc-status"]'), /42/);
    await r.context.close();
    r = await open({ width: 390, height: 844 }, { fail: true });
    await r.page.goto(base + '#node', { waitUntil: 'load' });
    await r.page.waitForSelector('[data-out="game-meta"] .state-warn', { state: 'attached' });
    assert.match(await r.page.textContent('[data-out="game-meta"]'), /works in Telegram/);
    await r.context.close();
  });

  await test('keyboard: skip link, Tab reaches nav, Enter switches module and moves focus to its heading', async () => {
    const { context, page } = await open({ width: 1440, height: 900 });
    await page.goto(base, { waitUntil: 'load' });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
    await page.focus('[data-nav="staking"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h-staking');
    assert.equal(await page.getAttribute('[data-nav="staking"]', 'aria-current'), 'page');
    assert.ok(await page.isVisible('#staking')); assert.ok(!(await page.isVisible('#overview')));
    await context.close();
  });

  await test('without JavaScript every module is readable', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'load' });
    for (const id of ['overview', 'wallet', 'node', 'my-nodes', 'network', 'activity', 'staking', 'security', 'settings']) assert.ok(await page.isVisible(`#h-${id}`), id);
    await context.close();
  });
} finally {
  await browser.close();
  server.close();
}
console.log(`hub browser tests passed: ${passed}`);
