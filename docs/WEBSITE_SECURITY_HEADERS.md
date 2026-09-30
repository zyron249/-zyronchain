# zyronchain.com HTTP security headers

## How the site is served (checked 2026-09-30)

- A Render **static site** (response header `rndr-id`), publishing `website/`, behind Cloudflare (`server: cloudflare`,
  `cf-ray`, `cache-control: public, max-age=0, s-maxage=300`). `www` redirects 301 to the apex.
- The service is managed in the Render dashboard. The repo has no `render.yaml` Blueprint, so response headers
  **cannot be set from repo config**. Adding a Blueprint file alone does nothing until someone connects it in the
  dashboard, and connecting one could take over other service settings.
- Live today: only `x-content-type-options: nosniff`.
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
