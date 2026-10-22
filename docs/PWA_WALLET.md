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
| Address | `ZYN` + first 40 hex of SHA-256(64-byte uncompressed public key), exactly as in `l1/src/crypto.ts`. Displayed with the display-only checksum from `docs/ADDRESS_CHECKSUM.md`. The primary Copy address action and the QR code use the canonical lower-case form. The checksummed form stays on screen and can be copied separately; it is display-only. |
| Lock / unlock | Auto-lock after 5 minutes without activity, or after 60 s in the background. Lock wipes the private-key buffer and drops the in-memory vault key (see Key storage). |
| Sign transfer | Offline, on the Send screen. Produces exactly l1's `transfer`. For chain id `zyron-wallet-testnet-1` the default transaction version is **1**, because that network runs protocol version 1 and rejects version 2. Other testnet and devnet chain ids default to version 2 (domain-separated), and version 2 stays selectable on every allowed chain. Chain ID and the next nonce are typed in by hand. The next nonce is the network's current nonce + 1 (1 for a new account). Nothing is fetched or guessed. Only chain IDs that contain `testnet` or `devnet` are signed (same rule as the Snap). A **review screen** shows Type, From, To, Amount, Fee, Total, Chain ID, Nonce and Timestamp (`describeTransfer`), and signing needs a deliberate confirmation. The signed transfer stays on the device until the owner dismisses it. `describeTransfer`/`signTransfer` refuse any other kind, extra fields (memo/data), messages or arbitrary JSON, so `mining_claim` is impossible. The mining-tracker address and self-sends are refused. A self-send is stopped before review with "You can't send to your own address. Enter a different recipient." See **Send-safety warnings** below. |
| Balance / broadcast | Disabled. The balance card says the balance isn't shown in this offline app and links to the separate read-only page at `/testnet/`. This app does not connect and does not show a balance number. A no-value testnet RPC exists for that page, the Snap and the CLI (`docs/WALLET_TESTNET_RPC.md`, chain id `zyron-wallet-testnet-1`). A signed `tx.json` can be submitted on `/testnet/` or later with the CLI (`tx-submit`). |
| Receive | Home screen. Checksummed address for reading, plain-address QR, and copy. The primary copy action copies the canonical lower-case address. No incoming list and no balance: the app does not connect. |
| Send / settings | Send holds the transfer form. Send also holds the address book: add, edit, delete (a second click confirms) and "Send to", which fills the receiver. Settings holds the large-amount warning threshold, the ZYN ↔ atoms converter, security notes, encrypted-vault export and delete. |
| Backup re-quiz | After each unlock, home shows a reminder until this session passes a 4-word check. The check asks for the device password, calls `openVault` on this device, then wipes the entropy. The flag is memory only (not IndexedDB, localStorage or the vault). Creating a wallet counts as the check for that session. |
| Other | Only the address and a signed transfer can be copied ("Copied. This app will try to clear the clipboard in 60 seconds."). If the browser blocks the timed clear, the screen says the clipboard was kept. Delete wallet = button → confirmation screen → acknowledgement + type DELETE (no secure-overwrite claim). Optional export and import of the password-encrypted vault file, read and written on this device only (the phrase is not in the file, and the file is not uploaded). Scam warning with "Official site: zyronchain.com"; static network status (`tools/site/network-status.mjs`); "Local wallet · Offline ready" indicator that never implies a network connection; English-only UI. |

## Key storage
- IndexedDB `zyron-wallet-app` / store `vault` holds **one encrypted vault and nothing else**. The UI refuses to
  persist anything that fails `assertVaultShape`.
- **Fail closed on load**: `parseVault` accepts only a plain object (or JSON text, at most `MAX_VAULT_TEXT` =
  69,632 characters, about 68 KB) that is exactly a version-1 or version-2 vault with the known fields for that
  version, types, KDF/cipher parameters and identity. Unknown versions (for example 3), malformed data, extra
  fields (including a `book` field on a version-1 vault) or odd prototypes are rejected. The stored record is left
  untouched and never rewritten. Creating or restoring is blocked, and the only offered action is an explicit,
  confirmed delete.
- **Crypto self-test on start**: the app refuses to run if the vendored libraries are missing or incomplete, or if
  a SHA-256 vector or the BIP-39/BIP-32 → address vector fails.
- Vault **version 2** (current; written by create, restore and the upgrade):
  - Fields: `format`, `version` (2), `createdAt`, `address`, `publicKey`, `derivationPath`, `words`, `kdf`,
    `cipher: { name, iv }`, `salt`, `ciphertext`, and **`book: { iv, ciphertext }`**.
  - Seed plaintext: the BIP-39 entropy (16 bytes for 12 words), in `ciphertext` with `cipher.iv`.
  - KDF: **scrypt N=2^17, r=8, p=1**, dkLen 32, 128 MiB (same parameters as the CLI keystore v2), via the vendored `@noble/hashes`.
  - Cipher: **AES-256-GCM** (Web Crypto). A new vault gets a fresh 16-byte salt. Every encryption uses a fresh
    12-byte IV.
  - Seed AAD: `zyronchain/pwa-vault/v2 \n scrypt:n=131072,r=8,p=1,dklen=32 \n aes-256-gcm \n <path> \n <publicKey> \n <address>`.
    Changing the version, KDF parameters, path or identity makes decryption fail. After decryption the key is
    re-derived and must match the stored public key and address.
  - **Encrypted book**: `book.ciphertext` is AES-256-GCM under the same scrypt key with its own 12-byte
    `book.iv`, which must differ from `cipher.iv` and is new on every save. The plaintext is canonical JSON
    `{ contacts: [{ name, address }], sent: [address], thresholdAtoms }`, holding the address book, the sent-to
    history and the large-amount threshold (`null` = off). Book AAD:
    `zyronchain/pwa-vault/v2/book \n <kdf label> \n aes-256-gcm \n <salt> \n <cipher.iv> \n <publicKey> \n <address>`,
    so a book cannot be moved to another vault or paired with another seed ciphertext. Saving the book re-seals
    only `book` and leaves the seed ciphertext unchanged. A decrypted book is validated by `parseBook` (fail closed).
  - Limits: at most **100 contacts** (names 1–64 characters after whitespace normalization, no control
    characters, no duplicate addresses, not the reserved system address; the app also refuses your own address), **200 sent-to
    history entries** (most recent first; older ones drop off), book plaintext at most 32 KB, vault JSON at most
    about **68 KB**.
- Vault **version 1** (older vaults, still readable): the same fields without `book`, seed AAD prefix
  `zyronchain/pwa-vault/v1`. It opens with an empty book.
- **v1 → v2 upgrade (`upgradeVault`)**: runs only in the unlock handler, after `openVault` succeeded with the
  right password (the seed decrypted and re-derived to the stored identity). It keeps `salt`, `address`,
  `publicKey`, `createdAt`, `derivationPath` and `words`, re-seals the seed under the v2 AAD with a fresh IV, adds
  an empty encrypted book, checks the result with `assertVaultShape` and then saves it through the single
  IndexedDB write path. The input vault object is not modified. A wrong password, a failed check or an unknown
  version never rewrites the stored record. Nothing is upgraded at startup or on import; an imported v1 file is
  upgraded at its first unlock. Upgrading a v2 vault is a no-op.
- **In-memory vault key**: unlocking (or creating/restoring) keeps a **non-extractable** AES-GCM `CryptoKey`
  derived from the password, so the book can be re-sealed after a contact or threshold change or a signed
  transfer without asking for the password again. The raw scrypt output is zeroed right after import. The
  `CryptoKey` and the decrypted book are memory only and are dropped on lock (manual, idle or background).
  Nothing about the book is kept in localStorage, cookies or a second IndexedDB record.
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

## Send-safety warnings
Checked on this device by `sendWarnings` before the transfer is built, against the decrypted book:
- **Own address** (blocking): "You can't send to your own address. Enter a different recipient." The review
  screen is not shown. `buildTransfer` refuses self-sends with the same text, and l1 rejects them too.
- **First-time recipient**: the receiver is not in the sent-to history. A saved contact that was never paid still
  warns, and the warning names the contact.
- **Large amount**: the amount is at or above the threshold set in Settings (stored in the encrypted book).

Non-blocking warnings are listed on the review screen and need their own checkbox ("I read these warnings and still
want to sign") in addition to the review checkbox. The sign handler checks both again. After a transfer is signed,
its receiver is added to the sent-to history and the book is re-saved. No warning check makes a network request.

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
  - `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0, `@scure/base` 2.4.0, `@scure/bip32` 2.4.0, `@scure/bip39` 2.4.0
    (the same `@noble/curves` and `@noble/hashes` tarball integrity as `l1/`)
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
- vault round-trip, wrong password, tamper cases (seed and book) and the fail-closed parser (unknown versions, malformed data);
- v1 → v2 migration from a stored v1 fixture (`tools/pwa-wallet/fixtures/vault-v1.json`, public test phrase), address-book round-trip and send-safety warning unit tests;
- signing review rows and refusal of unknown types/extra fields; crypto self-test; phrase-UX static checks;
- the CSP/SRI/no-network scans;
- headless-Chrome tests: SW install and offline load (also at `/app/`), Chrome installability, the full
  create → privacy → hidden cards (tap, hold, blur, auto-hide) → 4-word check (nothing saved before it passes) → home → QR → clipboard clear → review → confirmed sign → lock → wrong password → unlock → auto-lock → tamper →
  delete (ack + DELETE) → restore → rejected-vault (v3 / v1 with a book field / bad KDF / garbage) flow, v1 → v2 upgrade on unlock with address book, threshold and warnings, missing-crypto refusal, storage contents (only the vault; no localStorage/cookies), zero network requests while
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
- On iOS, add the app from Safari. Chrome, Telegram and X on iPhone do not offer Add to Home Screen. Confirm the address bar is `https://zyronchain.com/app/` before adding it; the home-screen app hides that bar. iPhone does not show the Android Install button. Private browsing hides the Share action.
- A malicious or compromised zyronchain.com deployment could ship code that steals phrases. SRI only pins the
  files that the served HTML names. Use the CLI for anything of value, and treat this as testnet software.
- Some mobile keyboards learn typed words. The restore box disables autocorrect and suggestions where the browser
  allows, but the keyboard is outside the app's control.
- This app does not connect (`connect-src 'none'`): no balance fetch, no nonce lookup, no broadcasting. The balance card only links to the separate read-only page at `https://zyronchain.com/testnet/`. The no-value wallet testnet RPC is for that page, the Snap and the CLI, not for this wallet.

## Updating
1. `cd tools/pwa-wallet && npm ci`
2. After changing a library version: `node build-vendor.mjs` (commit the bundle + `VENDOR.json`).
3. After any change under `website/app/`: `node stamp-app.mjs` (rewrites the SRI hashes and the SW asset list and version).
4. Run `node test-core.mjs --require-l1` and `node test-browser.mjs`. CI runs `--check` for both scripts.

## ZYRON NODE wallet link (testnet)
The ZYRON NODE Mini App can ask this wallet to prove that a player holds a testnet address.
- The Mini App opens `https://zyronchain.com/app/#link=<base64url(message)>`. The hash never reaches a server; the app
  drops it from the address bar after reading it.
- The wallet signs **only** the exact server template (`parseLinkMessage`): title with `TESTNET`, Telegram user id,
  network `zyron-wallet-testnet-1`, a 32-hex nonce, issue and expiry times (max 30 min), and a fixed "not a transaction"
  notice. Anything else, including an expired request, is refused before anything is shown as signable.
- After unlock, the link screen shows the address, network, expiry and the exact text; signing needs a deliberate checkbox.
- Signature: l1 `signCanonical` over `canonicalJson({ domain: "zyronchain/game/wallet-link/v1", payload: { message } })`
  (secp256k1, SHA-256 prehash, compact, low-S), a domain that can never be confused with a transaction.
- Output: a proof code `zyronlink1.<nonce>.<publicKey64>.<signature64>` to copy back into ZYRON NODE. Telegram's
  `startapp` deep link holds at most 64 characters, so the proof cannot ride a link back; the "Back to Telegram" link is
  the fixed `https://t.me/ZyronNodeBot`. The app still makes no network requests (CSP `connect-src 'none'`).
