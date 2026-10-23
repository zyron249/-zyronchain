#!/usr/bin/env node
// Static regression tests for ZYRON HUB (website/hub/). Runs in website CI; no browser needed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFlags } from './build-hub.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hub = join(repo, 'website', 'hub');
const html = readFileSync(join(hub, 'index.html'), 'utf8');
const js = readFileSync(join(hub, 'hub.js'), 'utf8');
const css = readFileSync(join(hub, 'hub.css'), 'utf8');
const visible = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const NON_ENGLISH = /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

test('strict CSP: no inline code, connect-src limited to the two public status origins', () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const d = Object.fromEntries(csp.split(';').map((p) => p.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.equal(d['default-src'], "'none'");
  assert.equal(d['script-src'], "'self'");
  assert.equal(d['style-src'], "'self'");
  assert.equal(d['connect-src'], 'https://zyron-node.onrender.com https://zyron-wallet-testnet-rpc.onrender.com');
  for (const k of ['object-src', 'frame-src', 'form-action', 'base-uri', 'worker-src']) assert.equal(d[k], "'none'", k);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=|style="/i, 'no inline script, handlers or styles');
});

test('only the game API and the wallet testnet are contacted; no keys, signing, storage or HTML injection', () => {
  const urls = [...js.matchAll(/https:\/\/[^'"`\s]+/g)].map((m) => m[0]).filter((u) => !u.startsWith('https:\\/')).sort();
  assert.deepEqual(urls, ['https://zyron-node.onrender.com', 'https://zyron-wallet-testnet-rpc.onrender.com/status']);
  const paths = [...js.matchAll(/\$\{GAME_API\}(\/api\/[a-z/]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(paths)], ['/api/meta', '/api/web/login/finish', '/api/web/login/start', '/api/web/logout', '/api/web/me']);
  assert.doesNotMatch(js, /getRandomValues|generateKey|importKey|deriveKey|subtle\.|secp256k1|mnemonic|privateKey|localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|credentials:\s*'include'/i);
  // Gameplay stays in Telegram: the Hub never calls a game action route.
  assert.doesNotMatch(js, /\/api\/(cycle|upgrade|tree|chests|streak|quests|wallet|referral)\b/);
  assert.match(js, /BOT_LINK = \/\^https:\\\/\\\/t\\\.me\\\/ZyronNodeBot/, 'bot link from the API is validated before use');
  assert.match(js, /credentials: 'omit'/);
  assert.match(js, /valueBearing !== false/, 'refuses to show a status that is not declared no-value');
});

test('all nine modules exist, each with a heading, nav entry and ARIA labelling', () => {
  for (const id of ['overview', 'wallet', 'node', 'my-nodes', 'network', 'activity', 'staking', 'security', 'settings']) {
    assert.match(html, new RegExp(`<section id="${id}" class="hub-section" aria-labelledby="h-${id}" data-section>`), id);
    assert.match(html, new RegExp(`id="h-${id}"`), `${id} heading`);
    assert.match(html, new RegExp(`<a href="#${id}" data-nav="${id}">`), `${id} nav`);
  }
  assert.match(html, /<nav class="hub-nav" aria-label="Hub sections">/);
  assert.match(html, /class="skip-link" href="#hub-main"/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /:root\s*\{/);
});

test('English only, honest wording, no forbidden terms', () => {
  for (const [f, s] of [['index.html', html], ['hub.js', js], ['hub.css', css]]) assert.ok(!NON_ENGLISH.test(s), `non-English letter in ${f}`);
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(visible, /\bminers?\b|\bmine ZYN\b|mining_claim|airdrop|APY|guaranteed|presale|buy now|price/i);
  assert.doesNotMatch(visible, /\b(mainnet|public testnet|testnet) (is )?(now )?(live|launched|activated)\b/i);
  assert.match(visible, /Mainnet is not activated/);
  assert.match(visible, /no conversion to ZYN/);
  assert.match(visible, /50,000,000 ZYN/);
  assert.ok(html.includes('disabled>Stake (not available)</button>'));
  assert.match(html, /data-action="signin-start">Sign in with Telegram</);
  assert.match(visible, /Gameplay stays in Telegram/);
});

test('launch flags block is generated from docs/l1-launch-authorization.json', () => {
  assert.ok(html.includes(renderFlags()), 'run node tools/site/build-hub.mjs');
  assert.match(html, /data-flag="mainnetAuthorized"><dt>[^<]+<\/dt><dd><span class="state state-(?:ok|off)">(?:Yes|No)<\/span> <strong class="state state-off hub-flag-notice">Mainnet is not live; activation is off<\/strong><\/dd>/, 'mainnet not-live notice must sit next to the authorization flag');
  assert.match(html, /data-flag="mainnetActivationAllowed"><dt>[^<]+<\/dt><dd><span class="state state-off">No</);
});

test('local links and assets resolve; external links are noopener', () => {
  for (const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const ref = m[1];
    if (ref.startsWith('#')) { assert.ok(html.includes(`id="${ref.slice(1)}"`), `broken fragment ${ref}`); continue; }
    if (/^https?:/.test(ref)) continue;
    const rel = ref.replace(/\?v=[0-9a-f]{12}$/, '');
    const p = normalize(join(hub, rel));
    assert.ok(existsSync(p) || existsSync(join(p, 'index.html')), `broken local ref ${ref}`);
  }
  for (const m of html.matchAll(/<a [^>]*href="https?:[^"]+"[^>]*>/g)) assert.match(m[0], /rel="noopener noreferrer"/, m[0]);
});

console.log(`hub tests passed: ${passed}`);
