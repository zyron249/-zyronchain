# ZyronChain website

Production static website for `https://zyronchain.com`. The website is intentionally isolated from the canonical `l1/` runtime and from validator consensus RPC.

## Production surfaces

- `index.html` — main ZyronChain product/protocol portal.
- `styles.css` / `app.js` — shared responsive presentation, navigation and progressive enhancement.
- `brand.css` — ZYRON CHAIN theme layer (wolf + Z mark), loaded last on every page: near-black background with a pure-CSS network grid, chrome headings, electric-blue accents and glass cards. No remote fonts/scripts, no `data:` URIs. Palette and asset pipeline: [`tools/brand/README.md`](../tools/brand/README.md).
- `brand/` — generated brand assets: header wordmark, hero banner (`zyron-banner-*.webp|jpg`, mobile crop `zyron-banner-m-*`), `og-image.jpg` (1200×630), `icon-512.png`, small favicons.
- `brand-mark.png` — wolf + Z mark (transparent) for header, footer and wallet identity.
- `favicon.ico` (16/32/48), `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png` — browser and home-screen icons from the same mark.
- `logo.svg` / `favicon.svg` — SVG wrappers (system-font wordmark + embedded raster mark).
- `wallet.html` — local-first wallet onboarding and security education.
- `wallet.js` — prepares pinned local wallet setup and backup-verify scripts, the address checker and transfer templates; it never generates, requests or uploads wallet secrets.
- `wallet-core.js` — public-data helpers (address format, display-only checksum per `docs/ADDRESS_CHECKSUM.md`, public key → address derivation via Web Crypto SHA-256, ZYN/atoms conversion, the password-strength rule embedded into the local scripts). No key generation, signing or decryption.
- `test-wallet-core.mjs` — `node website/test-wallet-core.mjs [--require-l1]`; proves the page's address rule equals the L1 (`l1/src/crypto.ts`) and that the restore test in the generated scripts decrypts a real L1 keystore.
- `wallet.css` — wallet-specific presentation.
- `validator.html` — browser-based validator configuration launchpad.
- `mining.html` — **retired** (mining shut down by owner decision, 2026-09-30). Kept only as a historical, `noindex` record; it is no longer linked from the site navigation. Public downloads stay fail-closed.
- Homepage tokenomics/market preview — shows the fixed 50M launch design under review and a deliberately disabled Buy/Sell surface. It must never accept funds or imply a quote asset/AMM is live before the corresponding protocol gates are closed.
- `validator.js` — generates local operator shell scripts; it does not generate or upload validator private keys.
- `validator.css` — launchpad-specific presentation.
- `robots.txt` / `sitemap.xml` / `site.webmanifest` — production discovery/PWA metadata.

## Product portal boundary

The website explains the canonical protocol, wallet model, ZYN supply rules, activation status, validator path, developer quick start and security/readiness model. It may link to canonical repository documents for deeper evidence, but it must not invent live network state or turn governance authorization into an activation claim. Testers are pointed at [`docs/PUBLIC_TEST.md`](https://github.com/zyron249/-zyronchain/blob/main/docs/PUBLIC_TEST.md) for the local `cd l1 && npm ci && npm run devnet` path. That is not a hosted testnet, and the site must not invent public RPC, explorer or faucet endpoints.

The portal must not:

- execute consensus in the browser;
- call validator consensus RPC directly;
- publish rehearsal/private RPC endpoints as public wallet endpoints;
- advertise a token sale, guaranteed return, price target or investment promise;
- claim public-testnet/mainnet activation when evidence gates remain open.

## Wallet Setup boundary

The wallet page is a **local setup assistant**, not a hosted wallet.

It may generate or download local terminal scripts that:

1. verify Node.js 22+ and local prerequisites;
2. clone the canonical repository and detach at a pinned reviewed revision;
3. install/build the canonical TypeScript L1 CLI;
4. ask for a wallet password (and its confirmation) **inside the local terminal** and reject weak ones (12+ characters, 6+ distinct, ~60+ estimated bits); `ZYRON_WALLET_PASSWORD` may be used for automation, with a printed warning;
5. create `wallet.json` with `keygen --out ... --password-file <temporary file>`; the temporary 0600 file lives in a private temp directory (RAM-backed `/dev/shm` where available) and is shredded/removed right after, including on errors and Ctrl+C — **no password file is left on disk**;
6. apply restrictive local permissions;
7. run a local restore test (decrypt, re-derive the address, print nothing secret);
8. print only the public `ZYN...` address, its checksummed display form and the keystore SHA-256 for backup verification.

A second script verifies a backup copy of `wallet.json` the same way on any machine; it prompts for the password (an existing password file may be passed instead).

The in-page address checker only handles public data (addresses and public keys) and uses no network.

The wallet website must never request, upload, persist or transmit:

- wallet passwords;
- plaintext private keys;
- encrypted keystore files;
- password files;
- signing requests;
- seed phrases or recovery secrets.

The wallet page must remain self-contained and must not use `fetch`, WebSocket, browser storage, remote JavaScript or remote web fonts. Public transaction examples stay placeholder/activation-gated until a separately controlled public wallet gateway and canonical network parameters are published.

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

Public-testnet validator enrollment stays visibly disabled while activation evidence is incomplete. The website must not turn governance authorization into a false activation claim.

## Local preview

From the repository root:

```sh
python3 -m http.server 8080 --directory website
```

Open:

- `http://127.0.0.1:8080/`
- `http://127.0.0.1:8080/wallet.html`
- `http://127.0.0.1:8080/validator.html`

## Deployment boundary

The production site is static and self-contained. Do not point browser JavaScript directly at validator consensus RPC ports. A future live explorer/status/wallet integration must use a separately controlled public/read-only or transaction-ingress gateway with explicit TLS, CORS, caching where appropriate, rate limits, bounded payloads and response-shape validation.

Publishing or improving this website does not change protocol activation flags and does not constitute a network launch.
## HTTP security headers

The site is a dashboard-managed Render static site behind Cloudflare, so response headers (HSTS, frame-ancestors / X-Frame-Options, Referrer-Policy, Permissions-Policy, nosniff) are configured outside the repo. See [`docs/WEBSITE_SECURITY_HEADERS.md`](../docs/WEBSITE_SECURITY_HEADERS.md) for the required values, steps and the `curl -I` check. `wallet.js` additionally refuses to render inside a frame.

## Phone wallet (PWA)

`website/app/` is a separate installable phone wallet (iOS + Android, "Add to Home Screen", offline app shell). It is testnet-only and unaudited. Unlike `wallet.html` it generates keys in the browser (an owner-approved exception scoped to `website/app/**`) and stores only a scrypt + AES-256-GCM vault in IndexedDB. Design, KDF measurements, limits and update steps are in [`docs/PWA_WALLET.md`](../docs/PWA_WALLET.md). Tests and the reproducible vendor build live in `tools/pwa-wallet/` and run in `.github/workflows/website-pwa-wallet.yml`.
