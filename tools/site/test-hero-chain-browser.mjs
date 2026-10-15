#!/usr/bin/env node
// Headless Chrome: the hero blockchain layer starts after load, never takes clicks, pauses when the hero is offscreen,
// draws nothing with prefers-reduced-motion, coexists with the Halloween layer, and adds no console or CSP errors.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = join(repo, 'website');
const { chromium } = createRequire(join(repo, 'tools', 'pwa-wallet', 'package.json'))('playwright-core');
const chromePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(site, p));
  if (!file.startsWith(site) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
const state = (page) => page.evaluate(() => window.ZyronHeroChain.state());
let passed = 0;
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const motion of ['no-preference', 'reduce']) {
    const ctx = await browser.newContext({ viewport, reducedMotion: motion });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|onrender/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route(/onrender\.com/, (r) => r.abort());
    await page.goto(`${base}/?season=halloween`, { waitUntil: 'load' });
    const before = await page.evaluate(() => document.querySelector('.hero-banner').getBoundingClientRect().height);
    await page.waitForFunction(() => window.ZyronHeroChain.state().status !== 'idle', null, { timeout: 5000 });
    const label = `${viewport.width}px ${motion}`;
    if (motion === 'reduce') {
      assert.equal((await state(page)).status, 'reduced', label);
      assert.equal(await page.locator('[data-hero-chain]').count(), 0, `${label} no canvas`);
    } else {
      await page.waitForFunction(() => window.ZyronHeroChain.state().frames > 10);
      const info = await page.evaluate(() => {
        const c = document.querySelector('[data-hero-chain]'), r = c.getBoundingClientRect(), b = c.parentElement.getBoundingClientRect();
        const e = document.elementFromPoint(r.left + r.width * 0.9, r.top + r.height * 0.2);
        return { pe: getComputedStyle(c).pointerEvents, hit: !!(e && e.closest('[data-hero-chain]')), fits: r.width === b.width && r.height === b.height, dpr: c.width / r.width, season: !!document.querySelector('[data-season-layer]') };
      });
      assert.equal(info.pe, 'none', label); assert.equal(info.hit, false, `${label} never takes hits`);
      assert.equal(info.fits, true, `${label} canvas fills banner`); assert.ok(info.dpr <= 2.01, `${label} dpr cap`);
      assert.equal(info.season, true, `${label} Halloween layer still present`);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForFunction(() => window.ZyronHeroChain.state().status === 'paused', null, { timeout: 3000 });
      const f1 = (await state(page)).frames; await page.waitForTimeout(600);
      assert.equal((await state(page)).frames, f1, `${label} no frames while offscreen`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction((f) => window.ZyronHeroChain.state().status === 'running' && window.ZyronHeroChain.state().frames > f, f1, { timeout: 3000 });
    }
    const after = await page.evaluate(() => document.querySelector('.hero-banner').getBoundingClientRect().height);
    assert.equal(after, before, `${label} no layout shift`);
    assert.deepEqual(errors, [], `${label} console/CSP errors`);
    await ctx.close();
    passed += 1;
    console.log(`ok - hero chain ${label}`);
  }
}
await browser.close();
server.close();
console.log(`hero chain browser tests passed: ${passed}`);
