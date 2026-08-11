# ZyronChain website

Production static website for `https://zyronchain.com`. The website is intentionally isolated from the canonical `l1/` runtime and from validator consensus RPC.

## Production surfaces

- `index.html` — main ZyronChain product/protocol portal.
- `styles.css` / `app.js` — shared responsive presentation, navigation and progressive enhancement.
- `logo.svg` — canonical website brand/wordmark asset.
- `favicon.svg` — compact ZyronChain protocol mark.
- `wallet.html` — local-first wallet onboarding and security education.
- `wallet.js` — prepares pinned local wallet setup scripts and transfer templates; it never generates, requests or uploads wallet secrets.
- `wallet.css` — wallet-specific presentation.
- `validator.html` — browser-based validator configuration launchpad.
- `validator.js` — generates local operator shell scripts; it does not generate or upload validator private keys.
- `validator.css` — launchpad-specific presentation.
- `robots.txt` / `sitemap.xml` / `site.webmanifest` — production discovery/PWA metadata.

## Product portal boundary

The website explains the canonical protocol, wallet model, ZYN supply rules, activation status, validator path, developer quick start and security/readiness model. It may link to canonical repository documents for deeper evidence, but it must not invent live network state or turn governance authorization into an activation claim.

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
4. ask for a wallet password **inside the local terminal**;
5. create `wallet.json` with `keygen --out ... --password-file ...`;
6. apply restrictive local permissions;
7. print only the public `ZYN...` address.

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