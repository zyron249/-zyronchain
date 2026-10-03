/*
 * ZyronChain PWA wallet service worker: offline app shell only.
 *
 * - Caches ONLY the same-origin static files listed in ASSETS (versioned cache). Code, HTML, CSS and the manifest
 *   are SHA-256-checked on install (any mismatch aborts the update); PNG icons are type-checked only.
 * - Answers ONLY same-origin GET requests for those exact paths. Every other request (other paths, other
 *   origins, non-GET, anything with a query string) is not intercepted at all and is never cached.
 * - The app never sends secrets over the network; the vault lives in IndexedDB, which this worker never opens.
 */
'use strict';

// BEGIN GENERATED (tools/pwa-wallet/stamp-app.mjs)
const VERSION = '2c16d265d54637cd';
const ASSETS = {
  "./index.html": "a6347cc2cbbcad70e8a23b74d5d5114e20c3758807467dee57e52dfb8c5b1d08",
  "./app.css": "0e4fb0622739ae3a2ca50ee88d6571d791473b1513097e2f729778c2181cd3ab",
  "./app.js": "c7bee3d8a93860acd9b8c59b3c5bb79e27798da2eaf1637f7c742fe1d78519b0",
  "./zyron-wallet-core.js": "4057cae04a2f77541f6bfeaf09d59f2e4e51b482b731dc5c3445e137cf2a29f7",
  "./vendor/noble-scure.js": "db17e57ac525ad905f77f606fe5b1b5bc898d8f6119e9d556ff2f49181dd5c4d",
  "./vendor/qr.js": "df7e5ee0f9db397a3f689313cc1bc8581e55e8752200309023df694d7e977612",
  "./manifest.json": "5908854c28f43fb93e6777c04b3678ed53f83b9b82cf8c702035688e856ebf4b",
  "./icons/icon-192.png": null,
  "./icons/apple-touch-icon-180.png": null,
  "./icons/maskable-192.png": null
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
      if (sha256 === null) {
        // Icons only: the CDN may losslessly re-encode images, so they are type-checked instead of hash-checked.
        if (!/^image\/png\b/.test(response.headers.get('Content-Type') || '') || !body.byteLength) throw new Error('Icon unavailable: ' + url.pathname);
      } else if (hex(await crypto.subtle.digest('SHA-256', body)) !== sha256) {
        throw new Error('App shell file failed its integrity check: ' + url.pathname);
      }
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
