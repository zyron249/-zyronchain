# ZYRON NODE threat model

Scope: the Telegram Mini App, bot, API, and Postgres/Redis data in `telegram-game/`. Out of scope: ZyronChain consensus, validator keys, and real ZYN transfers. Those stay in `l1/` and are not modified by this service.

## Assets

- Off-chain Zyron Points balances and the append-only ledger.
- Energy, upgrade levels, streaks, quest claims, achievements, and season scores.
- Telegram user ids and display names.
- Watch-only ZYN addresses. Never seeds, private keys, or keystores.
- Admin token, bot token, and the referral IP salt.
- Season snapshot exports.

Zyron Points are not ZYN and not Zyrum. There is no conversion rate and no automatic payout.

## Actors

- A player in the Telegram client.
- A modified or scripted client.
- Someone farming referrals or quests with many accounts.
- An operator with the admin token.
- A hostile or mistaken `ZYRON_RPC_URL`.

## Trust decisions

| Decision | Why |
|---|---|
| The server owns points, energy, level, and rewards | A Mini App can be patched in the browser. |
| Telegram `initData` is verified with HMAC-SHA256 and the bot token | The client cannot mint a user id. |
| `initData` may be replayed until it expires | It is a session credential. State changes use idempotency keys. |
| Bot updates are trusted only as responses from `getUpdates` | The bot token is what authenticates Telegram. |
| Wallet linkage stores the address only | The game cannot sign or broadcast. |
| Chain reads are allowlisted GETs | Submission and validator routes are out of bounds. |
| Admin routes require a bearer token compared in constant time | The dashboard can ban, snapshot, and close a season. |
| Forwarded client IP headers are trusted only from configured proxies | Otherwise a client can pick the address used for rate limits and referral network hashes. |
| Closing a season or exporting a snapshot does not pay anyone | Payouts are a later, explicit decision. |

## Abuse cases and controls

**Forged initData.** The hash is HMAC-SHA256 over the sorted data-check string, with the secret `HMAC_SHA256("WebAppData", bot_token)`. `auth_date` cannot be in the future (30s skew) or older than `INIT_DATA_MAX_AGE_SECONDS`. Failed auths are rate-limited per network hash.

**Replayed cycle / upgrade / wallet calls.** The ledger idempotency key is unique. The same player, scope, and key returns the original JSON and does not grant again. Database transactions cover the debit or credit and the idempotency row together. Player rows are locked with `SELECT … FOR UPDATE`.

**Energy drain or infinite tap.** Each cycle spends 1 server-side energy point. Regeneration uses server timestamps. A minimum interval (`CYCLE_MIN_INTERVAL_MS`, default 800) rejects extra cycles even with fresh keys. Per-user and per-IP fixed windows live in Postgres.

**Client-supplied balances.** No request field is a point amount, energy value, or level. Costs and rewards are computed from upgrade rows.

**Quest and achievement double claims.** Primary keys are `(player, quest, period)` and `(player, achievement)`. Ledger keys repeat that identity.

**Supply chest double opens.** The client sends a chest id, never an amount. Daily open uses the streak idempotency key. Quest open uses the same ledger key as quest sync. Level open uses `chest:{player}:level:{n}` plus `chest_claims`. A replay returns `gained: 0` and the live point balance. Sealed chests answer 409. The auto-run client waits at least `autoCyclePaceMs` (1.5s, or the cycle interval if that is slower) so a running node stays inside the 40 cycles / 60s budget.

**Referral farming.** A referee qualifies only after `REFERRAL_MIN_CYCLES` (default 15) and `REFERRAL_MIN_AGE_SECONDS` (default 30 minutes). Rewards are once per referral. A referrer can be paid for at most 20 qualified referrals per 7 days. Mutual links are refused. Six or more signups from one network hash in an hour are flagged and their referrals are rejected. Same-network referrals are flagged but not auto-rejected, because households share addresses. Abuse score at or above 80 blocks referral payout. It does not confiscate points already earned. The Security upgrade does not reduce abuse score or lift a ban.

**Wallet farming.** An address matches `^ZYN[0-9a-f]{40}$` and cannot be the all-zero tracker. The first operator to claim an address keeps it after unlink, so the link quest cannot be passed around. More than four link/unlink events in 24 hours is flagged and blocked. Admins can release a claim.

**Spoofed client IP.** Signup-network hashes and per-IP rate limits use the TCP peer address. `X-Forwarded-For`, RFC 7239 `Forwarded`, and `X-Real-IP` are read only when that peer falls inside `TRUSTED_PROXIES` or a CIDR/IP list in `TRUST_PROXY`. `TRUST_PROXY=1` does not mean "trust every connection" and the process refuses to boot with that setting unless an explicit list is also set. Hops that are themselves trusted proxies are skipped from the right, so a client cannot hide behind a trusted address it wrote at the left of the header. A missing or malformed forwarded header keeps the peer address.

**Dev and test backdoors.** `DEV_AUTH_BYPASS` and `ALLOW_TEST_CLOCK` refuse to boot when `ENVIRONMENT=production`. The test clock also refuses to boot unless `ENVIRONMENT=test`.

**RPC SSRF and accidental mainnet writes.** The client rejects non-GET paths, URL credentials, and metadata hosts. Non-loopback URLs require `ZYRON_RPC_ALLOW_REMOTE=1` and HTTPS. Responses are size-capped, cached (Postgres, and Redis when `REDIS_URL` is set), and limited to 30 upstream calls a minute. The game never POSTs a transaction.

**Admin token leak.** The token is not in the repository. The dashboard keeps it in `sessionStorage`. Snapshots omit Telegram ids. Audit rows record ban, resolve, release, snapshot, and close actions.

**Logging.** Logs are JSON on stdout. They include method, path, and status. They do not include initData, the bot token, or the admin token.

**Group administration.** The bot sets its own commands and the Play Zyron menu button. It does not change group permissions, history, admins, or other bots.

## Residual risk

- Telegram account takeover still owns that operator's points. That is outside this service.
- A stolen bot token can forge initData until it is rotated.
- Snapshot files are sensitive operational data even without Telegram ids. Treat them as private.
- Leaderboard queries scan the ledger. They are fine for a community season and will need a rollup if the table grows large.
- This document is not an audit of ZyronChain consensus.
