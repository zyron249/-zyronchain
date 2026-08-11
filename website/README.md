# ZyronChain website

Production static website for `https://zyronchain.com`. The website is intentionally isolated from the canonical `l1/` runtime and from validator consensus RPC.

## Production surfaces

- `index.html` — main ZyronChain protocol website.
- `logo.svg` — canonical website brand/wordmark asset.
- `favicon.svg` — compact ZyronChain protocol mark.
- `validator.html` — browser-based validator configuration launchpad.
- `validator.js` — generates local operator shell scripts; it does not generate or upload validator private keys.
- `validator.css` — launchpad-specific presentation.
- `styles.css` / `app.js` — shared responsive presentation and progressive enhancement.
- `robots.txt` / `sitemap.xml` / `site.webmanifest` — production discovery/PWA metadata.

## Validator Launchpad boundary

The website does **not** run consensus inside the browser. Browsers are not an acceptable boundary for durable inbound TCP consensus, always-on operation, or production validator-key custody.

Instead, the launchpad provides a two-stage workflow:

1. Generate a deterministic local identity setup script. The script checks Node.js 22+, checks out the pinned reviewed L1 release, builds the canonical node and creates an encrypted validator keystore **on the operator machine**.
2. Paste a common friends/private-testnet `genesis.json` and explicit PeerId-pinned P2P multiaddrs. The browser validates only public configuration and generates a local start script that binds validator RPC to `127.0.0.1` and exposes only the configured P2P TCP listener.

The launchpad must never request, upload, persist or transmit:

- `validator.json` private keystores;
- validator password files;
- HSM/KMS credentials;
- remote-signer tokens;
- consensus RPC credentials.

Public-testnet validator enrollment stays visibly disabled while `publicTestnetActivationAllowed` is false. The website must not turn governance authorization into a false activation claim.

## Local preview

From the repository root:

```sh
python3 -m http.server 8080 --directory website
```

Open:

- `http://127.0.0.1:8080/`
- `http://127.0.0.1:8080/validator.html`

## Deployment boundary

The production site is static and self-contained. Do not point browser JavaScript directly at validator consensus RPC ports. A future live explorer/status integration must use a separately controlled read-only gateway with explicit CORS, caching, rate limits and response-shape validation.

Publishing or improving this website does not change `publicTestnetActivationAllowed` or `mainnetActivationAllowed` and does not constitute a network launch.
