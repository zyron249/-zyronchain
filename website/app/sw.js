/*
 * ZyronChain PWA wallet service worker: offline app shell only.
 *
 * - Caches ONLY the same-origin static files listed in ASSETS (versioned cache). Code, HTML, CSS and the manifest
 *   are SHA-256-checked on install (any mismatch aborts the update); PNG icons are type-checked only.
 *   Scripts and the stylesheet use content-versioned URLs (?v=<sha256 prefix>), stamped by tools/pwa-wallet.
 * - Answers ONLY same-origin GET requests for those exact URLs (path + exact version query). Every other request
 *   (other paths, other origins, non-GET, other query strings) is not intercepted at all and is never cached.
 * - Updates: the first install activates immediately. A later version waits until the page asks for it
 *   ("Update now" sends the 'zyron-skip-waiting' message), so a running wallet is never swapped mid-flow.
 * - The app never sends secrets over the network; the vault lives in IndexedDB, which this worker never opens.
 */
'use strict';

// BEGIN GENERATED (tools/pwa-wallet/stamp-app.mjs)
const VERSION = 'cc35c8dce0303cec';
const ASSETS = {
  "./index.html": "e3d1288e65bc8f5901fe4360901ca38ec0a24e50db34669d4d342743519c2ce9",
  "./manifest.json": "83636b2a989ee4244d5e1d11c4575733f7341b15e9172196f400ec80c74f8498",
  "./icons/icon-192.png": null,
  "./icons/icon-512.png": null,
  "./icons/apple-touch-icon-180.png": null,
  "./icons/maskable-192.png": null,
  "./icons/maskable-512.png": null,
  "./app.css?v=2c477ce09709": "2c477ce09709fed0cb11241ee5795130c53e35e14bc54bc3f79868ad1848b168",
  "./vendor/noble-scure.js?v=8bc52c47d762": "8bc52c47d762268157b3c9828ca985424f3a0a7477a3e6547711313389e81705",
  "./vendor/qr.js?v=df7e5ee0f9db": "df7e5ee0f9db397a3f689313cc1bc8581e55e8752200309023df694d7e977612",
  "./zyron-wallet-core.js?v=86ec8474477c": "86ec8474477c3cd56d3fefa4f49fb19d00afd23d0ca39000f03f51a710eab9c6",
  "./app.js?v=2a533c96b60c": "2a533c96b60ca3f9bbbe83d16ae90f4f67d3f6e4c7d2961aff4ee59a1d9b8529"
};
// END GENERATED

const CACHE = 'zyron-wallet-app-' + VERSION;
const SCOPE_PATH = new URL('./', self.location).pathname; // "/app/"
const INDEX_PATH = SCOPE_PATH + 'index.html';

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const [entry, sha256] of Object.entries(ASSETS)) {
      const url = new URL(entry, self.location);
      // Versioned shell files already carry their own ?v=; plain files get the worker version to bypass stale CDN copies.
      const fetchUrl = url.search ? url.pathname + url.search : url.pathname + '?v=' + VERSION;
      const response = await fetch(fetchUrl, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('App shell file unavailable: ' + url.pathname);
      const body = await response.clone().arrayBuffer();
      if (sha256 === null) {
        // Icons only: the CDN may losslessly re-encode images, so they are type-checked instead of hash-checked.
        if (!/^image\/png\b/.test(response.headers.get('Content-Type') || '') || !body.byteLength) throw new Error('Icon unavailable: ' + url.pathname);
      } else if (hex(await crypto.subtle.digest('SHA-256', body)) !== sha256) {
        throw new Error('App shell file failed its integrity check: ' + url.pathname);
      }
      await cache.put(url.pathname + url.search, new Response(body, { headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' } }));
    }
    // First install: take over right away. Updates wait for the user's "Update now".
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'zyron-skip-waiting' && event.source && new URL(event.source.url).origin === self.location.origin) self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('zyron-wallet-app-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const SHELL_KEYS = new Set(Object.keys(ASSETS).map((entry) => { const url = new URL(entry, self.location); return url.pathname + url.search; }));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.hash) return;
  let key = url.pathname + url.search;
  if (request.mode === 'navigate' && !url.search && (url.pathname === SCOPE_PATH || url.pathname === INDEX_PATH)) key = INDEX_PATH;
  if (!SHELL_KEYS.has(key)) return; // not ours: let the network handle it, never cache it
  event.respondWith((async () => {
    const cached = await caches.match(key, { cacheName: CACHE });
    return cached || fetch(request);
  })());
});
