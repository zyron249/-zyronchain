#!/usr/bin/env node
// Halloween 2026 seasonal theme (website/season.js): date gating, overrides, and that the site and the game ship
// byte-identical gating logic. The phone wallet (website/app/) and the desktop wallet tool never load it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const S = require(join(repo, 'website', 'season.js'));
const at = (iso) => Date.parse(iso);

test('window is 2026-10-15 00:00 to 2026-11-01 00:00 America/New_York', () => {
  assert.equal(S.START_MS, at('2026-10-15T00:00:00-04:00'));
  assert.equal(S.END_MS, at('2026-11-01T00:00:00-04:00'));
});
test('off before the window', () => {
  assert.equal(S.active(at('2026-10-14T23:59:59-04:00'), ''), false);
  assert.equal(S.active(at('2026-01-01T12:00:00Z'), ''), false);
});
test('on during the window', () => {
  for (const t of ['2026-10-15T00:00:00-04:00', '2026-10-24T12:00:00-04:00', '2026-10-31T23:59:59-04:00']) assert.equal(S.active(at(t), ''), true, t);
});
test('off after the window (end exclusive) and in later years', () => {
  assert.equal(S.active(at('2026-11-01T00:00:00-04:00'), ''), false);
  assert.equal(S.active(at('2027-10-20T12:00:00Z'), ''), false);
});
test('?season=halloween previews and ?season=off forces off', () => {
  assert.equal(S.active(at('2026-06-01T00:00:00Z'), '?season=halloween'), true);
  assert.equal(S.active(at('2026-10-20T00:00:00Z'), '?season=off'), false);
  assert.equal(S.active(at('2026-10-20T00:00:00Z'), '?x=1&season=off'), false);
  assert.equal(S.active(at('2026-10-20T00:00:00Z'), '?season=bogus'), true);
  assert.equal(S.active(at('2026-06-01T00:00:00Z'), '?season=bogus'), false);
});
test('reduced motion is detected and missing matchMedia is safe', () => {
  assert.equal(S.reducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(S.reducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(S.reducedMotion({}), false);
});
test('game and site gating are identical; wallets never load it', () => {
  assert.equal(readFileSync(join(repo, 'website', 'season.js'), 'utf8'), readFileSync(join(repo, 'telegram-game', 'frontend', 'season.js'), 'utf8'));
  for (const f of ['app/index.html', 'wallet.html']) assert.doesNotMatch(readFileSync(join(repo, 'website', f), 'utf8'), /season\./, f);
  const css = readFileSync(join(repo, 'website', 'season.css'), 'utf8');
  assert.match(css, /\.season-layer \{[^}]*pointer-events: none/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.season-layer \{ display: none/);
  for (const f of ['season.js', 'season.css']) assert.doesNotMatch(readFileSync(join(repo, 'website', f), 'utf8'), /style=|data:/i, f);
});
