#!/usr/bin/env node
// Headless Chrome: the Halloween layer appears with ?season=halloween, is gone with ?season=off, never takes
// clicks, adds no console or CSP errors, and with prefers-reduced-motion shows no flying elements.
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
let passed = 0;
for (const path of ['/', '/hub/']) {
  for (const motion of ['no-preference', 'reduce']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: motion });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|onrender/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route(/onrender\.com/, (r) => r.abort());
    await page.goto(`${base}${path}?season=halloween`);
    const on = await page.evaluate(() => {
      const l = document.querySelector('[data-season-layer]');
      return { cls: document.documentElement.classList.contains('season-halloween'), layer: !!l, pe: l ? getComputedStyle(l).pointerEvents : null };
    });
    assert.equal(on.cls, true, `${path} class`);
    if (motion === 'reduce') assert.equal(on.layer, false, `${path} reduced motion has no flying layer`);
    else {
      assert.equal(on.layer, true, `${path} layer`);
      assert.equal(on.pe, 'none', `${path} pointer-events`);
      const hit = await page.evaluate(() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight * 0.1); return !!(e && e.closest('[data-season-layer]')); });
      assert.equal(hit, false, `${path} decorations never take hits`);
    }
    await page.goto(`${base}${path}?season=off`);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('season-halloween') || !!document.querySelector('[data-season-layer]')), false, `${path} off`);
    assert.deepEqual(errors, [], `${path} console errors`);
    await ctx.close();
    passed += 1;
    console.log(`ok - ${path} season (${motion})`);
  }
}
await browser.close();
server.close();
console.log(`season browser tests passed: ${passed}`);
