#!/usr/bin/env node
// Headless check of /verify/: the page reaches an explicit testnet state
// (verified headers, or an honest cold-start / unreachable message) and does
// not overflow. It does not invent a result when the gateway is down.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = join(repo, 'website');
const { chromium } = createRequire(join(repo, 'tools', 'pwa-wallet', 'package.json'))('playwright-core');
const chromePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/local/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!chromePath) throw new Error('Chrome is not installed');
const shots = process.env.VERIFY_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(site, path));
  if (!file.startsWith(site) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'X-Frame-Options': 'DENY' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });

try {
  for (const [width, height, name] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(base + '/verify/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const banner = document.querySelector('[data-banner]');
      return banner && banner.dataset.kind && banner.dataset.kind !== 'checking';
    }, null, { timeout: 120_000 });
    const report = await page.evaluate(() => {
      const banner = document.querySelector('[data-banner]');
      const box = document.documentElement.getBoundingClientRect();
      const wide = [...document.querySelectorAll('body *')].filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || getComputedStyle(el).position === 'fixed') return false;
        return r.right > document.documentElement.clientWidth + 1 || r.left < -1;
      }).slice(0, 4).map((el) => el.tagName.toLowerCase() + '.' + [...el.classList].join('.'));
      return {
        kind: banner.dataset.kind,
        summary: document.querySelector('[data-summary]').textContent,
        host: document.querySelector('[data-host]').textContent,
        chain: document.querySelector('[data-chain]').textContent,
        verified: document.querySelector('[data-verified-height]').textContent,
        network: document.querySelector('.verify-fact dd').textContent,
        statuses: [...document.querySelectorAll('[data-checks] [data-status]')].map((el) => el.dataset.status),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        wide
      };
    });
    assert.deepEqual(errors, [], `${name} page errors: ${errors.join('\n')}`);
    assert.equal(report.network, 'testnet');
    assert.ok(report.scrollWidth <= report.clientWidth + 1, `${name} horizontal overflow ${report.scrollWidth}>${report.clientWidth} ${report.wide.join(',')}`);
    assert.deepEqual(report.wide, [], `${name} elements outside the viewport`);
    const honest = /asleep|waking|unreachable|starting|not ready|retry|stopped|did not/i;
    if (report.kind === 'verified' || report.kind === 'verified-pin-mismatch') {
      assert.match(report.verified, /^[0-9]+$/);
      assert.ok(report.statuses.includes('passed'), 'expected a passed check');
      assert.ok(report.statuses.includes('not available on this network'), 'expected an explicit not-available check');
      assert.notEqual(report.chain, 'unknown');
    } else {
      assert.match(report.kind, /^(cold|asleep|unreachable|degraded|backoff|failed|refused|unavailable)$/);
      assert.match(`${report.summary} ${report.host}`, honest);
      assert.equal(report.verified, 'none');
    }
    if (shots) await page.screenshot({ path: join(shots, `verify-${name}.png`), fullPage: true });
    console.log(`ok - ${name} ${report.kind} verified=${report.verified} chain=${report.chain}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
