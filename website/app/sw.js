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
const VERSION = '9c795f022d3e78e2';
const ASSETS = {
  "./index.html": "e0263040232e986f3b9089e60f1f19e257274442bdcc8684d4842dd2759bc25a",
  "./manifest.json": "3ab5a6037d573313f52f8aa6102591c4e6c539681eff81aea0afb1220c17c01a",
  "./icons/icon-192.png": null,
  "./icons/apple-touch-icon-180.png": null,
  "./icons/maskable-192.png": null,
  "./app.css?v=b1551d90d0ac": "b1551d90d0ac226613210b2d67eac02f15d24298241cdeb01071c0d16d2c932e",
  "./vendor/noble-scure.js?v=db17e57ac525": "db17e57ac525ad905f77f606fe5b1b5bc898d8f6119e9d556ff2f49181dd5c4d",
  "./vendor/qr.js?v=df7e5ee0f9db": "df7e5ee0f9db397a3f689313cc1bc8581e55e8752200309023df694d7e977612",
  "./zyron-wallet-core.js?v=527c72cc63ac": "527c72cc63acb8b24cef318ed88aa126df01a7ab25ae8db0ca0edbffc851b8a1",
  "./app.js?v=dda463d0a93a": "dda463d0a93a11a88b6acf7bd891f8e8ed2bdea76a0271124a2bdf3818d6455a"
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
