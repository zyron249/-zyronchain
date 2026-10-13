# ZYRON HUB architecture

Status: **Phase 0 (audit) and Phase 1 (static Hub interface) implemented.** Phases 2-6 are designs only.

ZYRON HUB (`website/hub/`, served at `https://zyronchain.com/hub/`) is one entry point to the ZyronChain ecosystem: wallet, the ZYRON NODE game, network state, launch status and, later, node monitoring. A single portal does **not** mean a single security domain. Each layer keeps its own boundary, and the Hub links between them rather than merging them.

Hard rules for every phase: total supply is fixed at 50,000,000 ZYN; no `mining_claim`, no mint, no genesis or consensus change; no invented balances, metrics or RPC claims; Zyron Points never equal ZYN; no airdrop promises; UI text never says "miner" (use "builders" or "virtual node").

## 1. Phase 0 audit: current state (main at 03840cf)

| Area | What exists | State |
|---|---|---|
| `l1/` canonical TypeScript L1 | Ledger + State-v2, consensus v6 (locked two-phase, quorum finality), p2p, light client, keystore, remote signer, RPC with rate limits | IMPLEMENTED, TESTED (CI `l1.yml`); public network BLOCKED by activation gates |
| Fixed supply | `tokenomics.ts` 5M / 20M / 20M / 5M, `fixed-supply-v1` genesis profile, `allocation-locks.ts` (founder vesting, permanent-liquidity lock) | IMPLEMENTED, TESTED; mainnet genesis ceremony NOT DONE |
| Mining | `mining_claim` rejected on every path; `miningRewardAtoms` = 0 | Retired (by owner decision) |
| Fees | `applyTransfer` debits `amount + fee` and credits only `amount`, so fees are burned | IMPLEMENTED |
| `website/` information site | Static, `connect-src 'none'`, build-time network status, English-only and honesty tests | IMPLEMENTED, TESTED (`website-ci.yml`) |
| `website/app/` Phone Wallet PWA | Create, restore, lock/unlock, scrypt + AES-256-GCM vault, address + QR, offline-signed testnet transfers, wallet-link proof signing; CSP `default-src 'none'; connect-src 'none'` | IMPLEMENTED, TESTED (`website-pwa-wallet.yml`, l1 cross-check) |
| `website/wallet.html` | Desktop wallet setup (no browser key handling) | IMPLEMENTED |
| Wallet testnet RPC | `zyron-wallet-testnet-rpc.onrender.com`, chain `zyron-wallet-testnet-1`, `valueBearing: false`, faucet; free host, sleeps and may reset | IMPLEMENTED (no value) |
| `telegram-game/` ZYRON NODE | FastAPI + Postgres, Telegram `initData` auth, builders, upgrades, chests, tiers, activity ledger, referrals, community bot, reminders | IMPLEMENTED, TESTED (`telegram-game-ci.yml`), live |
| `wallet_proof.py` | One-time nonce bound to player + Telegram id; secp256k1 proof checked exactly like l1; nonce burned on every attempt; cosmetic badge only | IMPLEMENTED, TESTED; real-Telegram end-to-end PENDING REVIEW |
| Game `/api/meta` | Public build, season, points notice | IMPLEMENTED; CORS allows only the Mini App origin, so **zyronchain.com cannot read it yet** |
| MetaMask Snap (`snap/`) | Testnet-only signing | IMPLEMENTED; not on npm, not tested in Flask |
| Staking / delegation | none | NOT IMPLEMENTED in the protocol |
| Node monitoring gateway | none | NOT IMPLEMENTED |
| Web login for the game | none | NOT IMPLEMENTED |

`docs/l1-launch-authorization.json`: `publicTestnetAuthorized` and `mainnetAuthorized` are true, but `publicTestnetActivationAllowed` and `mainnetActivationAllowed` are **false**, with 10 and 12 open requirements. Anything value-bearing depends on those gates.

## 2. Staking: answers from the code

- **Does the protocol support staking or delegation?** No. The transaction kinds are `transfer`, `activity_settlement`, `mining_claim` (always rejected), `validator_update` and `protocol_upgrade` (`l1/src/types.ts`). There is no bond, delegation, unbonding or slashing state.
- **How are validators admitted?** By `validator_update`: a new validator set (address + public key, equal weight) with an activation height, approved by signatures from the current validators. Admission is governance by the existing set, not by locked stake. `validator-admission-removal-governance` is still an open mainnet requirement.
- **Where would rewards come from?** Nowhere today. Nothing is minted (fixed supply, mining retired) and fees are burned, not paid to proposers. `validator-reward-inflation-and-fee-policy` is an open mainnet requirement.
- **Does it fit the fixed supply and genesis locks?** Only if rewards are paid from ZYN that already exists, for example a governed, disclosed slice of the ecosystem/community reserve, distributed by a new audited transaction type through a `protocol_upgrade`. Inflationary staking would break the 50M cap and is ruled out. Locked allocations (founder vesting, permanent liquidity) must not be stakeable to bypass their locks. Stake-weighted admission would also change consensus and needs an independent audit.
- **Hub behavior:** the Staking module says "Not supported by the protocol" and the Stake button is disabled. No APY or reward figures are shown.

## 3. Three-layer separation

```
 L1 core (l1/)                 Wallet + app layer                      Game layer (telegram-game/)
 validators, consensus RPC     website/app  (keys, signing)            Telegram Mini App + API + Postgres
 never exposed to browsers     connect-src 'none', encrypted vault     Telegram initData auth, off-chain Points
          |                    website/hub  (no keys, read-only)                 |
          |                    connect-src = 2 public status origins             |
          +-- status gateway (Phase 4, read-only) --> Hub <-- /api/meta (public) -+
```

- **L1 core:** browsers never call a validator's consensus RPC. Public data reaches the Hub only through a separate read-only gateway (Phase 4) or a no-value testnet service.
- **Wallet:** keys exist only inside `website/app/`. Its CSP stays `connect-src 'none'`, it is never framed or embedded by the Hub, and the Hub never asks for a phrase, key or signature. Cross-layer actions use explicit, user-approved signed messages (the existing wallet-link proof).
- **Hub:** a static page with no keys and no browser storage (the site CI forbids `localStorage`/`indexedDB` and key APIs outside `website/app/`). It may read only `https://zyron-node.onrender.com` and `https://zyron-wallet-testnet-rpc.onrender.com`, with `credentials: 'omit'`. It writes remote data with `textContent` only, and it refuses an RPC status that does not declare `valueBearing: false`.
- **Game:** owns Points and player state. Points have no conversion rate to ZYN.

## 4. Phase 2 design: secure Telegram web login (not implemented)

Goal: show a player's own game data in the Hub without trusting any client-supplied id.

Option A, **Telegram Login Widget**: Telegram signs `id, first_name, auth_date, hash` with HMAC-SHA256 keyed by `SHA256(bot_token)`. The server verifies the hash, rejects `auth_date` older than 5 minutes, and maps to the existing player by Telegram id. The widget needs `/setdomain zyronchain.com` in BotFather and a `telegram.org` script plus frame in the Hub CSP.

Option B (recommended), **bot-issued one-time code**: the Hub asks the API for a login request and shows a short code plus a `t.me/ZyronNodeBot?start=login-<request>` deep link. The user confirms in the bot, which is already authenticated by Telegram, and the API binds the request to that Telegram id. The Hub polls once per a few seconds, then exchanges the request for a session. This needs no third-party script in the Hub, and the confirmation happens inside Telegram.

Either way:
- Session: random 256-bit id, stored server-side (hashed), `HttpOnly; Secure; SameSite=Strict` cookie on an API subdomain, or a short-lived bearer token held in memory only. TTL 30 minutes, idle timeout, logout revokes it.
- Replay: login requests are one-time, expire in 120 s, and are burned on use. The widget `auth_date` window is 5 minutes, and a used hash is stored for that window.
- CSRF: state-changing calls need `SameSite=Strict` plus an `Origin` allow-list and a per-session CSRF token. Phase 2 web endpoints are read-only (profile, ledger) at first.
- Rate limits: reuse `limits.py`, per IP and per Telegram id, for request creation, polling and exchange.
- CORS: add exactly `https://zyronchain.com` to `CORS_ORIGINS`, with credentials only if cookies are used. Never `*` with credentials.
- Never trust `telegram_id` from the browser; identity comes only from a verified Telegram signature or the bot confirmation.
- Web and Telegram read the same `players` row, so data stays consistent by construction. Gameplay actions stay in Telegram until a separate review.

## 5. Phase 4 design: node monitoring gateway (not implemented)

A separate, read-only status service (not a validator). It polls validator RPC `/status`-style endpoints over a private path, caches a sanitized snapshot (height, finalized height, peer count, version, last seen), and serves it as static JSON with CORS for zyronchain.com only. No write methods, no tx relay, no keys, strict rate limits. Before any public network exists, the gateway shows only a local devnet that the operator runs on their own machine (documented in `l1/LOCAL_DEVNET.md`). "My Nodes" ownership would later be proven with a validator-key-signed challenge, mirroring `wallet_proof.py`.

## 6. Threat model per phase

| Phase | Main threats | Controls |
|---|---|---|
| 1 Hub UI | XSS from remote JSON; fake "live" claims; key phishing via a lookalike UI | Strict CSP, `textContent` only, type-checked fields, `valueBearing` guard, no key inputs anywhere, honesty tests |
| 2 Web login | Forged identity, session theft, replay, CSRF, brute force on codes | Server-verified Telegram identity only, one-time short-TTL codes, hashed sessions, SameSite/Origin/CSRF, rate limits |
| 3 Wallet integration | Hub obtaining keys; signature misuse across domains | Keys stay in `website/app/`; domain-separated signed messages (existing `LINK_SIGNING_DOMAIN`); explicit user approval |
| 4 Node monitoring | Consensus RPC exposure, DoS, spoofed node status | Separate gateway, read-only cached snapshot, no pass-through, signed ownership proofs |
| 5 Mobile | Store-build supply chain, signing-key custody, WebView injection | Reproducible builds, credentials outside the repo and owner-held, no remote code |
| 6 Release | Untested activation, missing audits | Launch flags stay false until the authorization JSON changes through governance |

## 7. Mobile and store roadmap (Phase 5, not implemented)

1. Keep the PWA as the canonical wallet (installable on iOS and Android today).
2. Package with a thin native shell (Capacitor or a Trusted Web Activity on Android) that loads **bundled** assets, never remote code. The wallet's CSP and vault format stay unchanged.
3. Use platform secure storage (Keychain / Android Keystore) only as an extra wrap around the existing vault, after review.
4. Store submission, signing keys and developer accounts need owner approval and possible cost (Apple Developer Program). Nothing is submitted without it.

## 8. Phase 1 deliverable (this change)

- `website/hub/index.html`, `hub.css`, `hub.js`: nine modules (Overview, Wallet, ZYRON NODE, My Nodes, Network, Activity, Staking, Security, Settings). Desktop sidebar, mobile bottom nav, skip link, `aria-current`, focus management, reduced motion, and full content without JavaScript.
- Live data: game `/api/meta` (shown only when CORS allows it; otherwise an explicit reason) and wallet testnet `/status`. Launch flags are generated at build time from the authorization JSON by `tools/site/build-hub.mjs`, and CI fails if they are stale.
- Disabled with reasons: web sign-in, personal activity, Hub balances, My Nodes, Staking.
- Tests: `tools/site/test-hub.mjs` (CSP, endpoints, forbidden APIs and words, links, flags) and `tools/site/test-hub-browser.mjs` (6 viewports, keyboard, fixtures for both services, failure fallbacks, XSS-as-text, no-JS).
