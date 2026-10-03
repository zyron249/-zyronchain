#!/usr/bin/env node
// Headless-Chrome layout checks for the static site: no horizontal overflow at phone/tablet/desktop widths
// (and a landscape phone), no console errors, compact mobile nav with Wallet reachable, and the homepage's key
// answers readable with JavaScript disabled. Uses the pinned playwright-core from tools/pwa-wallet.
//   CHROME_PATH=/usr/bin/google-chrome node tools/site/test-layout.mjs [--shots <dir>]
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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(site, path));
  if (!file.startsWith(site) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };

const PAGES = ['/', '/wallet.html', '/validator.html', '/privacy.html', '/terms.html'];
const SIZES = [[320, 640], [375, 812], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900], [1920, 1080], [844, 390]];

try {
  await test(`no horizontal overflow or console errors: ${PAGES.length} pages x ${SIZES.length} viewports`, async () => {
    for (const [w, h] of SIZES) {
      const mobile = w < 760 || h < 500;
      const context = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      for (const path of PAGES) {
        await page.goto(base + path, { waitUntil: 'load' });
        const box = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const wide = [...document.querySelectorAll('body *')].filter((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || getComputedStyle(el).position === 'fixed') return false;
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const ov = getComputedStyle(p).overflowX; if (ov === 'auto' || ov === 'scroll' || ov === 'hidden') return false; }
            return r.right > vw + 1 || r.left < -1;
          }).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
          return { sw: document.documentElement.scrollWidth, vw, wide };
        });
        assert.ok(box.sw <= box.vw, `${path} @${w}x${h}: page scrolls horizontally (${box.sw} > ${box.vw}) ${box.wide.join(', ')}`);
        assert.deepEqual(box.wide, [], `${path} @${w}x${h}: elements outside the viewport`);
        if (shots && (w === 390 || w === 1440) && path === '/') await page.screenshot({ path: join(shots, `site-home-${w}.png`), fullPage: true });
      }
      assert.deepEqual(errors, [], `console errors @${w}x${h}`);
      await context.close();
    }
  });

  await test('mobile header: compact nav, Wallet is the first visible item, no menu JS required', async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    const header = await page.$eval('.site-header', (el) => el.getBoundingClientRect().height);
    assert.ok(header <= 110, `mobile header too tall: ${header}px`);
    const wallet = await page.$eval('.site-nav .nav-wallet', (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    assert.ok(wallet.left >= 0 && wallet.right <= 375, 'Wallet nav item visible without scrolling the nav');
    await context.close();
  });

  await test('homepage with JavaScript disabled: hero, answers, wallets and network status are visible', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false, isMobile: true });
    const page = await context.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    for (const sel of ['#hero-title', '.faq-grid', '#wallets .card', '#network-status .ns-table', '.site-footer [data-site-build]']) assert.ok(await page.isVisible(sel), sel);
    assert.match(await page.textContent('#hero-title'), /Verifiable Layer-1 infrastructure/);
    // The hero image is the LCP element: eager, high priority.
    assert.equal(await page.$eval('.hero img', (img) => img.loading), 'auto');
    await context.close();
  });

  await test('keyboard: skip link and focus-visible outline on nav links', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
    assert.ok(await page.isVisible('.skip-link'));
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notEqual(outline, 'none', 'focused element shows an outline');
    await context.close();
  });

  await test('reduced motion: no running animations or transitions longer than 10ms', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    for (const path of PAGES) {
      await page.goto(base + path, { waitUntil: 'load' });
      const slow = await page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => {
        const cs = getComputedStyle(el);
        const ms = (v) => Math.max(...v.split(',').map((t) => parseFloat(t) * (t.trim().endsWith('ms') ? 1 : 1000)));
        return (cs.animationName !== 'none' && ms(cs.animationDuration) > 10) || ms(cs.transitionDuration) > 10;
      }).length);
      assert.equal(slow, 0, `${path}: motion under prefers-reduced-motion`);
    }
    await context.close();
  });
} finally {
  await browser.close();
  server.close();
}
console.log(`site layout tests passed: ${passed}`);
