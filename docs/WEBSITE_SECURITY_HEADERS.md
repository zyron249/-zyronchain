# zyronchain.com HTTP security headers

## How the site is served (checked 2026-09-30)

- A Render **static site** (response header `rndr-id`), publishing `website/`, behind Cloudflare (`server: cloudflare`,
  `cf-ray`, `cache-control: public, max-age=0, s-maxage=300`). `www` redirects 301 to the apex.
- The service is managed in the Render dashboard. The repo has no `render.yaml` Blueprint, so response headers
  **cannot be set from repo config**. Adding a Blueprint file alone does nothing until someone connects it in the
  dashboard, and connecting one could take over other service settings.
- Live as of 2026-10-02: all six headers in the table below are served on every path (set as Render
  dashboard header rules). `Cross-Origin-Opener-Policy` is not served yet (optional, see below).
- In-page mitigations already shipped: a `<meta http-equiv="Content-Security-Policy">` (a meta CSP cannot express
  `frame-ancestors`), `<meta name="referrer" content="no-referrer">` on the wallet page, and a JavaScript
  anti-framing guard in `website/wallet.js` that hides the page when it is framed.

## Headers to add (all paths `/*`)

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | `frame-ancestors 'none'; base-uri 'self'; object-src 'none'` |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()` |
| `X-Content-Type-Options` | `nosniff` |

Browsers enforce both the header CSP above and the page's meta CSP (the stricter result applies), so this adds
framing protection without loosening the existing script/style/connect rules.

Before adding `; preload` to HSTS or submitting to hstspreload.org, confirm every subdomain is HTTPS-only.

### Optional: `Cross-Origin-Opener-Policy: same-origin`

No page on the site opens, or relies on being opened by, a cross-origin window, so COOP `same-origin` only
removes cross-window references. The phone-wallet browser suite (`tools/pwa-wallet/test-browser.mjs`) serves it on
every response, and the whole flow (create, quiz, unlock, sign, service-worker install, offline reload, update
prompt) passes with it. Add it to `/*` once it has also been checked on a real iPhone (Safari and the installed
Home Screen app), which this repo's CI cannot emulate.

## Caching (checked 2026-10-02)

Every response is served with `cache-control: public, max-age=0, s-maxage=300`: browsers revalidate on each
load, Cloudflare may keep a copy for up to five minutes. Caching stays on; staleness is handled by versioning:

- Site CSS/JS links carry a content version (`./site.css?v=<sha256[:12]>`, written by
  `tools/site/stamp-site.mjs`, checked in CI). New HTML therefore never pairs with an old stylesheet.
- The phone wallet loads `/app/<file>?v=<sha256[:12]>` with SRI (written by `tools/pwa-wallet/stamp-app.mjs`).
  Its service worker caches exactly those URLs, checks every hash at install and shows
  "A new Zyron Wallet version is available" when a new worker is waiting. The page shows its build id.
- The site manifest is `site-manifest.json` (served as `application/json`). The old `site.webmanifest` was
  served as `binary/octet-stream` by the host, which browsers may ignore.

Recommended Render header rules (dashboard → Settings → Headers), so HTML, the worker and manifests never sit in
the CDN for five minutes after a deploy:

| Path | Name | Value |
|---|---|---|
| `/` | `Cache-Control` | `no-cache` |
| `/*.html` | `Cache-Control` | `no-cache` |
| `/app` and `/app/` | `Cache-Control` | `no-cache` |
| `/app/sw.js` | `Cache-Control` | `no-cache` |
| `/app/manifest.json` | `Cache-Control` | `no-cache` |
| `/site-manifest.json` | `Cache-Control` | `no-cache` |

`no-cache` still allows caching with revalidation (ETag / Last-Modified are served), it is not `no-store`.
Versioned assets keep the default. Browsers already bypass the HTTP cache for `sw.js` because the page registers
it with `updateViaCache: 'none'`; the rule above removes the remaining CDN window. These rules need dashboard
access and are not applied from the repository.

Verify:

```bash
for p in / /app/ /app/sw.js /app/manifest.json /site-manifest.json; do
  curl -sI "https://zyronchain.com$p" | grep -iE '^(cache-control|content-type)'; done
```

## Option A: Render dashboard (free)

1. dashboard.render.com → workspace with the ZyronChain services → the static site serving zyronchain.com.
2. **Settings → Headers → Add Header**. For each row above: Path `/*`, Name, Value. Save.
3. Render applies the change without a rebuild. Cloudflare may serve cached copies for up to 5 minutes
   (`s-maxage=300`); purge or wait.

## Option B: Cloudflare (free plan)

1. Cloudflare → zyronchain.com → **Rules → Transform Rules → Modify Response Header → Create rule**,
   "All incoming requests". Add each header with **Set static**, then Deploy.
2. HSTS can instead be set under **SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS)**
   (max-age 12 months, include subdomains, no preload at first).

## Option C: Render connector

Authorize the Render MCP connector for the workspace that holds the ZyronChain services. Note that the connector
currently exposes deploys, env vars and metrics but no headers tool, so Option A or B is still needed for headers.

## Verify

```bash
curl -sI https://zyronchain.com/wallet.html | grep -iE 'strict-transport|x-frame|content-security|referrer-policy|permissions-policy|x-content-type'
```
Expect all six headers. Also re-open `/wallet.html` in a browser and confirm the page still works: the
header CSP only restricts framing, `<base>` and plugins.
