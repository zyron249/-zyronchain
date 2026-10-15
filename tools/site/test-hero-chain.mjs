#!/usr/bin/env node
// Homepage hero blockchain layer (website/hero-chain.js): side-only zones, mobile node budget, DPR cap,
// reduced-motion detection, and CSS/HTML contracts (pointer-events none, external deferred script, CSP untouched).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H = createRequire(import.meta.url)(join(repo, 'website', 'hero-chain.js'));
const site = (f) => readFileSync(join(repo, 'website', f), 'utf8');

test('the ZYRON logo and the wolf stay clear on desktop and mobile', () => {
  for (const [x, y] of [[0.3, 0.55], [0.45, 0.6], [0.65, 0.45], [0.75, 0.6]]) assert.equal(H.inZones(x, y, H.ZONES_WIDE), false, `wide ${x},${y}`);
  for (const [x, y] of [[0.3, 0.5], [0.75, 0.5], [0.85, 0.4]]) assert.equal(H.inZones(x, y, H.ZONES_NARROW), false, `narrow ${x},${y}`);
  assert.equal(H.zonesFor(390), H.ZONES_NARROW);
  assert.equal(H.zonesFor(1440), H.ZONES_WIDE);
});
test('fewer nodes on mobile and DPR capped at 2', () => {
  assert.ok(H.nodeCount(390) < H.nodeCount(1440));
  assert.equal(H.dprFor(3), 2); assert.equal(H.dprFor(1.5), 1.5); assert.equal(H.dprFor(undefined), 1);
});
test('reduced motion is detected and missing matchMedia is safe', () => {
  assert.equal(H.reducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(H.reducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(H.reducedMotion({}), false);
});
test('contracts: external deferred script, pointer-events none, reduced motion hides it, CSP unchanged', () => {
  const html = site('index.html');
  assert.match(html, /<script src="\.\/hero-chain\.js\?v=[0-9a-f]{12}" defer><\/script>/);
  assert.match(html, /script-src 'self'; style-src 'self'/);
  assert.match(site('site.css'), /\.hero-chain \{[^}]*pointer-events: none/);
  assert.match(site('site.css'), /prefers-reduced-motion: reduce\) \{ \.hero-chain \{ display: none/);
  assert.doesNotMatch(site('hero-chain.js'), /style=|data:|innerHTML|eval\(/);
  for (const f of ['app/index.html', 'wallet.html', 'hub/index.html']) assert.doesNotMatch(site(f), /hero-chain/, f);
});
