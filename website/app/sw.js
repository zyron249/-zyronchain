/*
 * ZyronChain PWA wallet service worker: offline app shell only.
 *
 * - Caches ONLY the same-origin static files listed in ASSETS (versioned cache, integrity-checked on install).
 * - Answers ONLY same-origin GET requests for those exact paths. Every other request (other paths, other
 *   origins, non-GET, anything with a query string) is not intercepted at all and is never cached.
 * - The app never sends secrets over the network; the vault lives in IndexedDB, which this worker never opens.
 */
'use strict';

// BEGIN GENERATED (tools/pwa-wallet/stamp-app.mjs)
const VERSION = '6bdd1d57663aa085';
const ASSETS = {
  "./index.html": "9d16d7676dabe910fe5f9ba1ff79aaf1bd93f40275535523d044f69fd67bc368",
  "./app.css": "2c1fbffa0f5131b59a7ef4692b4fa51bd17db2f72d293a99e8d96bb6acf84d00",
  "./app.js": "c7bee3d8a93860acd9b8c59b3c5bb79e27798da2eaf1637f7c742fe1d78519b0",
  "./zyron-wallet-core.js": "4057cae04a2f77541f6bfeaf09d59f2e4e51b482b731dc5c3445e137cf2a29f7",
  "./vendor/noble-scure.js": "db17e57ac525ad905f77f606fe5b1b5bc898d8f6119e9d556ff2f49181dd5c4d",
  "./vendor/qr.js": "df7e5ee0f9db397a3f689313cc1bc8581e55e8752200309023df694d7e977612",
  "./manifest.webmanifest": "b4fb4d3c038550c24cdc85a263a1fef476852614f58bad4acea6706ad04189b1",
  "./icons/icon-192.png": "d4478ac4b1705956c823fc0fb0feb547be38c2451391221cf7fd746efecb29e0",
  "./icons/apple-touch-icon-180.png": "ba1fcad58d405b35303d5f820844b35e6c0a69944f20733a5a89b0e58d82769a",
  "./icons/maskable-192.png": "f3a36df86930c609d5188e4d3ea40713832b407751797c68f964a1a50f5097b7"
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
    for (const [path, sha256] of Object.entries(ASSETS)) {
      const url = new URL(path, self.location);
      // The version query bypasses stale CDN copies; the response is stored under the plain path.
      const response = await fetch(url.pathname + '?v=' + VERSION, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('App shell file unavailable: ' + url.pathname);
      const body = await response.clone().arrayBuffer();
      const digest = hex(await crypto.subtle.digest('SHA-256', body));
      if (digest !== sha256) throw new Error('App shell file failed its integrity check: ' + url.pathname);
      await cache.put(url.pathname, new Response(body, { headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' } }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('zyron-wallet-app-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const SHELL_PATHS = new Set(Object.keys(ASSETS).map((path) => new URL(path, self.location).pathname));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || url.hash) return;
  let path = url.pathname;
  if (request.mode === 'navigate' && path === SCOPE_PATH) path = INDEX_PATH;
  if (!SHELL_PATHS.has(path)) return; // not ours: let the network handle it, never cache it
  event.respondWith((async () => {
    const cached = await caches.match(path, { cacheName: CACHE });
    return cached || fetch(request);
  })());
});
