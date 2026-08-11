# ZyronChain website

Standalone static portal for ZyronChain. This directory is intentionally isolated from the canonical `l1/` runtime and the legacy Python/Flask explorer.

## Goals

- Present the canonical Layer-1 honestly without investment-price language.
- Keep governance authorization separate from activation/certification claims.
- Link directly to canonical operator, readiness, security and technical-paper material.
- Remain deployable as plain static files with no backend trust dependency.
- Leave room for a future read-only explorer/status adapter without exposing validator RPC directly.

## Local preview

From the repository root:

```sh
python3 -m http.server 8080 --directory website
```

Then open `http://127.0.0.1:8080`.

## Files

- `index.html` — portal content and navigation.
- `styles.css` — responsive visual system.
- `app.js` — minimal progressive enhancement only.

## Deployment boundary

The site is static. Do not point browser JavaScript directly at validator consensus RPC ports. A future live status/explorer integration should use a separately controlled, read-only gateway with explicit CORS, caching, rate limits and response-shape validation.

Publishing this website does not change `publicTestnetActivationAllowed` or `mainnetActivationAllowed` and does not constitute a network launch.
