# ZyronChain Phone Wallet — Testnet (PWA): `website/app/`

**Status: TESTNET ONLY · UNAUDITED.** Do not hold real value with it until an independent security review is done.
Live at `https://zyronchain.com/app/`. The **Desktop Wallet Setup** page (`website/wallet.html`, CLI-first) stays
the recommended path for anything serious.

## What it is
An installable web app for iOS and Android ("Add to Home Screen"). There is no app store and no computer is needed.

| Feature | Notes |
|---|---|
| Create | 128-bit entropy from `crypto.getRandomValues` gives a 12-word BIP-39 phrase. Flow: device password (with strength meter) → **privacy screen** that must be acknowledged → **hidden word cards** → randomized **4-word backup check** → only then is the vault saved. |
| Phrase privacy | Before reveal, a privacy screen explains: anyone with the words controls the wallet; support never asks; never send them on Telegram, Discord, X, email or to "support"; never enter them on airdrop/validator sites; write on paper; nobody may see the screen. Words are blurred placeholders until a card is tapped (the real word enters the DOM only while revealed); "Hold to reveal all" shows them only while pressed; everything hides after 20 s of inactivity, on window blur and when the app is backgrounded. There is no copy-phrase control, copy/cut/drag are blocked on the word list, and the app never claims screenshots are blocked (a web app cannot block them). During creation only the entropy bytes are held (wipeable); words are derived on demand for a revealed card or the check. After saving, the entropy is zeroed and all references are dropped; the app says honestly that JavaScript GC cannot guarantee erasure. |
| Restore | Accepts a 12/15/18/21/24-word BIP-39 phrase (English list, checksum verified, no BIP-39 passphrase). |
| Derivation | BIP-32 secp256k1 `m/44'/249249'/0'/0/0`, the same path as the MetaMask Snap (PR #922), so the same words give the same address in both. `249249'` is a **provisional** coin type (not registered in SLIP-44); changing it later would change every address. |
| Address | `ZYN` + first 40 hex of SHA-256(64-byte uncompressed public key), exactly as in `l1/src/crypto.ts`. Displayed with the display-only checksum from `docs/ADDRESS_CHECKSUM.md`. The QR code holds the plain lower-case address. |
| Lock / unlock | Auto-lock after 5 minutes without activity, or after 60 s in the background. Lock wipes the key buffer. |
| Sign transfer | Offline. Produces exactly l1's `transfer` (v2 domain-separated by default, v1 optional). Chain ID and the next nonce are typed in by hand; nothing is guessed. A **review screen** shows Type, From, To, Amount, Fee, Chain ID, Nonce and Timestamp (`describeTransfer`), and signing needs a deliberate confirmation. `describeTransfer`/`signTransfer` refuse any other kind, extra fields (memo/data), messages or arbitrary JSON, so `mining_claim` is impossible. The mining-tracker address and self-sends are refused. |
| Balance / broadcast | Disabled, with an honest "no public RPC yet" notice. A signed `tx.json` can be submitted later with the CLI (`tx-submit`). |
| Other | ZYN ↔ atoms converter; only the address and a signed transfer can be copied ("Copied. Clipboard will be cleared automatically.", cleared after 60 s); delete wallet = button → confirmation screen → acknowledgement + type DELETE (no secure-overwrite claim); scam warning with "Official site: zyronchain.com"; static network status (`tools/site/network-status.mjs`); "Local wallet · Offline ready" indicator that never implies a network connection; English-only UI. |

## Key storage
- IndexedDB `zyron-wallet-app` / store `vault` holds **one encrypted vault and nothing else**. The UI refuses to
  persist anything that fails `assertVaultShape`.
- **Fail closed on load**: `parseVault` accepts only a plain object (or JSON text) that is exactly a version-1 vault
  with the known fields, types, KDF/cipher parameters and identity. Unknown versions, malformed data, extra fields
  or odd prototypes are rejected; the stored record is left untouched (never migrated or rewritten), creating or
  restoring is blocked, and the only offered action is an explicit, confirmed delete.
- **Crypto self-test on start**: the app refuses to run if the vendored libraries are missing or incomplete, or if
  a SHA-256 vector or the BIP-39/BIP-32 → address vector fails.
- Vault v1 contents:
  - Plaintext encrypted: the BIP-39 entropy (16 bytes for 12 words).
  - KDF: **scrypt N=2^17, r=8, p=1**, dkLen 32, 128 MiB (same parameters as the CLI keystore v2), via the vendored `@noble/hashes`.
  - Cipher: **AES-256-GCM** (Web Crypto) with a fresh 16-byte salt and 12-byte IV for every encryption.
  - AAD: `zyronchain/pwa-vault/v1 \n scrypt:n=131072,r=8,p=1,dklen=32 \n aes-256-gcm \n <path> \n <publicKey> \n <address>`.
    Changing the version, KDF parameters, path or identity makes decryption fail. After decryption the key is
    re-derived and must match the stored public key and address.
  - Exact KDF parameters are required, which blocks downgrades and memory-exhaustion vaults.
- Byte buffers (entropy, seed, private key, scrypt output) are zeroed after use. JavaScript strings (the phrase
  while it is on screen, the password while it is typed) cannot be wiped; they are dropped as soon as possible.
- The password rule is the same as the CLI's: 12+ characters, 6+ distinct characters, ≥60 estimated bits.

### KDF measurement and choice (headless Chrome, 2026-10-01)
| | desktop (1×) | 4× CPU throttle | 6× CPU throttle |
|---|---|---|---|
| scrypt N=2^17 r=8 (JS, 128 MiB) | 0.48 s | 1.9 s | 2.9 s |
| scrypt N=2^16 r=8 (JS, 64 MiB) | 0.24 s | 1.0 s | 1.5 s |
| PBKDF2-SHA256 600k (Web Crypto, native) | 0.09 s | 0.09 s* | 0.09 s* |
| PBKDF2-SHA256 1M (Web Crypto, native) | 0.15 s | 0.15 s* | 0.15 s* |

\* The native PBKDF2 runs off the throttled JS thread, so throttling does not apply to it.

**Choice: scrypt N=2^17.** It is memory-hard (much costlier to attack with GPUs/ASICs than PBKDF2), matches the
CLI keystore v2, and a 2–4 s unlock on a mid-range phone is acceptable for a wallet. On very old phones the
128 MiB allocation could fail; the app then shows the error and nothing is lost (the phrase still restores elsewhere).

## Security boundaries
- **CSP** (meta):
  ```
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self';
  connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'
  ```
  There is no `unsafe-inline`/`unsafe-eval`, no inline scripts, styles or handlers, and the page itself cannot
  make network requests. The Render headers add `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS,
  Referrer-Policy, Permissions-Policy and nosniff; none of them affect the service worker or the manifest (verified live).
- **SRI** on every script and on the stylesheet.
- **Vendored libraries** in `website/app/vendor/` are built reproducibly by `tools/pwa-wallet/build-vendor.mjs`
  from exact pinned versions:
  - `@noble/curves` 2.3.0, `@noble/hashes` 2.3.0, `@scure/base` 2.3.0, `@scure/bip32` 2.3.0, `@scure/bip39` 2.3.0
    (the same noble versions and tarball integrity as `l1/`)
  - `qr` 0.6.0 (encoder only)
  
  `VENDOR.json` records the npm integrity and the bundle hashes, and `LICENSES.txt` holds the MIT/Apache licenses.
  Nothing is loaded from a CDN or any third party.
- **Service worker** (`website/app/sw.js`, scope `/app/`):
  - Caches only the listed same-origin app-shell files, in a versioned cache.
  - Every code/HTML/CSS/manifest file's SHA-256 is checked during install; a mismatch aborts the install and the
    previous version stays. PNG icons are only type-checked, because Cloudflare's image optimization re-encodes
    them in transit (observed live).
  - Scripts and the stylesheet are loaded as `/app/<file>?v=<sha256[:12]>` (content-versioned, with SRI), so a
    deploy never mixes old and new files from a browser or CDN cache.
  - Answers only same-origin GET requests for exactly those URLs (path plus the stamped version query; `/app/`
    and `/app/index.html` map to the cached shell). Everything else (other paths, other queries, other origins,
    non-GET) is never intercepted and never cached.
  - It never opens IndexedDB. Old caches are deleted on activate.
  - **Updates**: the first install activates at once. A later version installs in the background and waits; the
    page then shows "A new Zyron Wallet version is available." with **Update now**. The button posts
    `zyron-skip-waiting` (the only message the worker accepts, and only from a same-origin page) and the page reloads
    when the new worker takes control, which also locks the wallet. While a wallet is being created, a transfer is
    under review or a signed transaction is on screen, the update is deferred with a hint. The page checks for a
    new version when it becomes visible again (at most every 30 minutes); browsers also check on navigation.
  - **Build id**: `stamp-app.mjs` writes `<meta name="zyron-build" content="app=<version>;release=<release ref>">`
    and the footer shows `Build <app[:8]> · release <release[:8]>`. The app version equals the worker `VERSION`.
- **Static CI scans**: no `fetch`/XHR/WebSocket/EventSource/sendBeacon/dynamic import in the page code or vendor
  bundles; no `eval`/`new Function`; no HTML injection sinks; exactly one IndexedDB write path.

### CI exception (browser key handling)
`website-ci.yml` forbids key generation, signing, decryption and browser storage in **every** browser script on
the site **except** `website/app/**`. That exception was approved by the owner for this phone wallet, which has
its own stricter workflow, `.github/workflows/website-pwa-wallet.yml`, covering:
- reproducible vendor bundles and current SRI/SW stamps;
- Snap vectors, an independent node:crypto BIP-32 reference and l1 address rules;
- signed transfers byte-identical to l1 `createTransfer`, plus l1 `validateTransactionShape` and mempool admission;
- vault round-trip, wrong password, 13 tamper cases and the fail-closed parser (unknown versions, malformed data);
- signing review rows and refusal of unknown types/extra fields; crypto self-test; phrase-UX static checks;
- the CSP/SRI/no-network scans;
- headless-Chrome tests: SW install and offline load (also at `/app/`), Chrome installability, the full
  create → privacy → hidden cards (tap, hold, blur, auto-hide) → 4-word check (nothing saved before it passes) → home → QR → clipboard clear → review → confirmed sign → lock → wrong password → unlock → auto-lock → tamper →
  delete (ack + DELETE) → restore → rejected-vault (v2 / bad KDF / garbage) flow, missing-crypto refusal, storage contents (only the vault; no localStorage/cookies), zero network requests while
  creating/signing, no third-party requests, the update prompt (a simulated deploy waits, is deferred during
  creation, then activates and reloads on "Update now"), the build id, 360/390/414 px layouts, and frame blocking.
  The test server sends the production headers plus `Cross-Origin-Opener-Policy: same-origin`.

Lighthouse 12 removed the PWA category, so installability is checked with Chrome's own
`Page.getInstallabilityErrors` (the signal Lighthouse used).

## Limits and advice
- **The recovery phrase on paper is the only real backup.** Site data can be lost:
  - iOS/iPadOS Safari may delete a website's storage after 7 days without use. Home-screen web apps are treated
    separately, but data is still lost if the app is removed, the device runs low on storage, or "Clear History
    and Website Data" is used.
  - Android Chrome can evict data under storage pressure unless persistence is granted (the app requests it and
    shows the result).
- On iOS, use Safari to add the app to the home screen (iOS 16.4+ also allows other browsers' share menus).
- A malicious or compromised zyronchain.com deployment could ship code that steals phrases. SRI only pins the
  files that the served HTML names. Use the CLI for anything of value, and treat this as testnet software.
- Some mobile keyboards learn typed words. The restore box disables autocorrect and suggestions where the browser
  allows, but the keyboard is outside the app's control.
- There is no public RPC: no balances, no nonce lookup, no broadcasting.

## Updating
1. `cd tools/pwa-wallet && npm ci`
2. After changing a library version: `node build-vendor.mjs` (commit the bundle + `VENDOR.json`).
3. After any change under `website/app/`: `node stamp-app.mjs` (rewrites the SRI hashes and the SW asset list and version).
4. Run `node test-core.mjs --require-l1` and `node test-browser.mjs`. CI runs `--check` for both scripts.
