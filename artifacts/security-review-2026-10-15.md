# ZyronChain defensive security review

Reviewed commit: `8b8b300b3c77847418e5020b68f51013f64cb07f` (origin/main, 2026-10-15).

This pass did not write exploits, payloads, or reproduction procedures. It did not change consensus, wallet, or game code, and it did not flip any activation flag. No allocation addresses, keys, or metrics were invented.

## Executive summary

No critical opening was found that lets an outsider mint ZYN, move the fixed 50,000,000 supply, or take a phone-wallet seed off the device.

The chain code already rejects every `mining_claim`, caps activity-oracle payouts, and enforces founder vesting and the permanent-liquidity lock when a genesis declares `launchProfile: "fixed-supply-v1"`. Those rules are opt-in. A genesis that omits the profile does not get them. Trading preflight still exits with a refusal. `publicTestnetActivationAllowed` and `mainnetActivationAllowed` are both false.

What must stay blocked is operational, not a missing line of code: real role addresses are not pinned, oracle approval is still a single key unless the genesis opts into m-of-n, consensus will start with one validator, and there has been no independent audit.

The red phone-wallet CI job is a version pin. L1 uses `@noble/curves` 2.4.0 and the wallet bundle is still 2.3.0. That is not a seed-theft bug. See finding I1.

## Attack-surface map

| Surface | What it can do today | Trust boundary |
|---|---|---|
| Canonical L1 (`l1/`) | Local or operator node. Default RPC bind is `127.0.0.1`. | Signed transactions and >2/3 validator finality. Consensus HTTP writes require peer authentication once the node is not on loopback. |
| Open-testnet gateway (`l1/scripts/open-testnet.mjs`) | Optional no-value network. Default gateway bind is `127.0.0.1`. Status says `valueBearing: false`. | Accepts only `transfer`. Faucet pays test ZYN. Four fresh test validators. Not mainnet. |
| Legacy Python/Flask (`app.py`, `zyron/`) | Separate historical chain. Binds `0.0.0.0` if someone runs it. | Not the canonical L1. Do not treat its balances as ZYN. |
| Website (`website/`) | Static pages. Marketing CSP is `connect-src 'none'`. | Scripts are same-origin only. Homepage hero and Halloween layer do not fetch. |
| Hub (`website/hub/`) | Read-only status plus Telegram web sign-in. | CSP allows only the game API and the wallet-testnet status URL. Session token stays in memory. |
| Phone wallet (`website/app/`) | Offline key vault and transfer signing. | `connect-src 'none'`. Encrypted vault in IndexedDB. No balance RPC. |
| ZYRON NODE game (`telegram-game/`) | Off-chain points, leaderboard, cosmetic wallet badge. | Telegram `initData` HMAC, or the Hub one-time code. Points are not ZYN. |

## Findings

| ID | Severity | Finding | Evidence | Impact | What to do |
|---|---|---|---|---|---|
| H1 | High (gate) | Value-bearing mainnet, public testnet activation, and trading are still refused. Keep them refused. | `docs/l1-launch-authorization.json` (`mainnetActivationAllowed: false`, `publicTestnetActivationAllowed: false`). `docs/fixed-supply-launch-plan.json` (`consensusEnforcementImplemented: false`, `websiteTradingActivated: false`). `l1/test/trading-activation-gate.test.ts` expects exit status 2 and the text `activation REFUSED`. | Turning a flag on would present test software as money. The plan flag stays false on purpose until an independent audit, even though the vesting code path exists. | Do not activate. Do not publish a mainnet chain ID, RPC, faucet, or quote asset. |
| H2 | High (gate) | Vesting and the liquidity lock apply only when the genesis opts in. | `l1/src/chain.ts` `validateGenesis` calls `assertFixedSupplyLaunchProfile` only if `launchProfile` is present. `l1/src/allocation-locks.ts` returns immediately when there are no locks. `docs/GENESIS_CONFIG_BINDING.md` states that omitting the profile keeps legacy behaviour. | A file that looks like a 50M chain but omits `launchProfile` can skip the 5M/20M/20M/5M split, the 12-month cliff, and the permanent-liquidity lock. | The ceremony must use `launchProfile: "fixed-supply-v1"` and `cd l1 && npm run tokenomics:check` must exit 0 before the genesis is signed or started. Record the genesis file SHA-256. |
| H3 | High (gate) | One activity-oracle key can still move 10,000 ZYN per 24 hours from the 5M ecosystem pool. | Cap: `l1/src/activity.ts` (`MAX_ACTIVITY_SETTLEMENT_ATOMS`, rolling window only for `fixed-supply-v1`). Single-key authorization when `activityOracleThreshold` is absent: `l1/src/activity-oracle.ts`. Open testnet builds one oracle and no threshold: `l1/scripts/open-testnet.mjs`. | The pool cannot be emptied in one settlement. It can be emptied over about 500 days by whoever holds that one key. m-of-n exists and is optional. | Do not fund a value-bearing pool until m, n, and the key holders are chosen and the threshold is in the genesis. Leave the open testnet unfunded of real value. |
| H4 | High (gate) | Consensus accepts 1 to 100 validators. Protocol v6 with fewer than 4 only prints a warning. | `l1/src/chain.ts` (`Genesis validator count must be between 1 and 100`). `l1/src/cli.ts` warns when v6 `validatorCount < 4`. Open testnet uses four names (`VALIDATOR_NAMES`). | One validator finalizes alone. Three validators tolerate zero faults under the v6 note in the CLI. | Do not start a value-bearing network until the intended set is in the genesis and operated by separate parties. A code change that refuses n < 4 would be a consensus change; it is not in this pass. |
| H5 | High (gate) | The 20M public-distribution allocation is spendable on day one. Real role addresses are not in the repository. | `l1/src/tokenomics.ts` locks only `founderVesting` and `permanentLiquidity`. Public distribution is the remaining allocation. `docs/PUBLIC_LAUNCH_CHECKLIST.md` section 4. | Whoever holds that key can move 20M ZYN immediately. That is the published plan, and it is unsafe until the address and its custody are chosen outside this repo. | Do not invent an address here. Pin the four role addresses in the ceremony record after `tokenomics:check`. |
| L1 | Low | Same-network game referrals are flagged and still paid, up to the weekly cap. | `telegram-game/src/zyron_node/game.py` `maybe_attach_referral` adds `same_ip_referral` at weight 15 once. `qualify_referral` pays unless `abuse_score >= 80` (`ABUSE_REFERRAL_BLOCK` in `economy.py`) or the referrer already has 20 rewarded referrals in 7 days (`REFERRAL_WEEKLY_CAP`). | Extra off-chain Zyron Points for someone who creates several Telegram accounts. This does not mint ZYN and does not change a chain balance. | Leave it while points are not redeemable. If points are ever tied to ZYN, stop same-network referrals before payout and review again. |
| L2 | Low | A stolen Telegram Mini App `initData` string stays valid for the configured age, 12 hours by default. | `telegram-game/src/zyron_node/config.py` default `INIT_DATA_MAX_AGE_SECONDS` is 43,200. `auth.py` checks HMAC, duplicate keys, and `auth_date`. Production refuses `DEV_AUTH_BYPASS`. | The thief can play that game account until the string expires. No wallet seed and no ZYN. | Keep the bypass off. A shorter max age is reasonable defense in depth; do not do it in a way that logs players out of a normal Telegram session without checking the client. |
| L3 | Low | Game admin routes rely on the bearer token alone. | `telegram-game/src/zyron_node/api.py` `require_admin`. `auth.py` `admin_authorized` uses `hmac.compare_digest`. Production requires the token to be at least 24 characters. | Online guessing of a long random token is not practical. A missing rate limit matters only if the token is short or reused. | Keep the token long, random, and out of the repo. Add a limit on failed admin attempts when that route is next touched. |
| L4 | Low | The game verifies wallet-link signatures with its own secp256k1 code. | `telegram-game/src/zyron_node/wallet_proof.py`. The phone wallet will sign only the fixed testnet template in `website/app/zyron-wallet-core.js` (`parseLinkMessage`). | The badge is cosmetic. A mismatch cannot mint ZYN. The check requires low-S, a point on the curve, and the standard ECDSA relation. This pass did not treat that as a break. | Keep the reward cosmetic. Later, verify with the same library the L1 uses, in a change that has cross-implementation tests. |
| I1 | Info | Phone-wallet CI is red because `@noble/curves` 2.3.0 is not the L1 2.4.0 tarball. | `l1/package.json` and `l1/package-lock.json` pin 2.4.0 (`sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==`). `tools/pwa-wallet/package.json` and `website/app/vendor/VENDOR.json` pin 2.3.0. `tools/pwa-wallet/test-core.mjs` asserts equal integrity. GitHub Actions run `38756437379` failed with `AssertionError: same @noble/curves tarball as l1`. | Not a custody bug. The wallet does not use X25519. The published X25519 timing note was fixed in 2.3.0. 2.4.0 hardens verify-side identity handling, DER bounds, and protocols this wallet does not call (FROST, BLS, OPRF). The wallet page does not call `verifyCanonical`. L1 consensus verify already runs on 2.4.0. Signing uses explicit compact, low-S, prehash options. | Rebuild the vendor bundle on the L1 pin in its own change and re-run `node tools/pwa-wallet/test-core.mjs --require-l1` plus the browser suite. Do not block mainnet on this red job alone, and do not ship the rebuild without those tests. |
| I2 | Info | RPC bind treats the hostname `localhost` as loopback. | `l1/src/node-base.ts` `assertSafeRpcBinding`. Already noted in `docs/PUBLIC_LAUNCH_CHECKLIST.md`. | A client that uses the name `localhost` for plaintext HTTP is in the documented DNS-rebinding class. The listen socket for that name is still loopback. | Prefer literal `127.0.0.1` or `::1` in operator docs and flags. |
| I3 | Info | Website release pin matches the reviewed L1 base. Homepage hero does not widen the page. | `website/release.js` pins `37d636fc9996f50d74769ce99139c8705e9fff5b`. No files under `l1/`, `WHITEPAPER.md`, `docs/L1_THREAT_MODEL.md`, or `docs/STANDALONE_L1_READINESS.md` changed after that commit up to `8b8b300b`. `website/hero-chain.js` draws a canvas, has no network calls, and is loaded under `script-src 'self'`. `website/season.js` is the same. | The pin is one cosmetic and one legacy-Python commit behind HEAD. That matches the pin workflow. The hero cannot read keys or call an RPC. | On the next website change, move the pin if canonical L1 files have moved. |
| I4 | Info | The open-testnet snapshot file contains test private keys, sealed with AES-256-GCM. | `l1/scripts/open-testnet.mjs` `sealSnapshot` / `buildSnapshot`. `GET /state/snapshot` is served when `ZYRON_TESTNET_STATE_SECRET` is set (32+ characters, SHA-256 domain-separated key, random 12-byte IV, GCM tag). `restoreNetwork` refuses a chain ID that is not a testnet id. | Anyone who has the secret and can download the snapshot gets the test validators, faucet, founder, liquidity, and oracle keys. Those keys are test keys. Reusing them on a value-bearing chain would hand that chain over. | Keep `valueBearing` false. Never copy that secret or those key files into a mainnet host. |

## What is already solid

- **Supply.** `MAX_SUPPLY` is 50,000,000 ZYN. `MINING_RETIRED` is constantly true. `assertMiningNotRetired` runs from transaction parsing (`l1/src/transaction.ts`), mempool admission, block validation (`l1/src/chain.ts`), and both state appliers (`l1/src/state.ts`, `l1/src/state-v2.ts`). A claim throws before any credit. Fees are removed from the sender and are not credited to the receiver, so they shrink supply. Activity settlements move coins out of the pool; they do not mint. The pool cannot receive funds (`assertNoActivityPoolInflow`).
- **Locks, when the launch profile is set.** Founder spend cannot drop the balance below the still-locked part of the genesis allocation (365-day cliff, then 1,095 days linear, using the block timestamp). The permanent-liquidity address cannot send, including a fee. Under the same profile the activity pool cannot be spent by a normal transfer.
- **RPC.** Non-loopback listen fails closed without consensus peer authentication and an HTTPS trusted-proxy list (`assertSafeRpcBinding`). Consensus POST paths call `preauthorizeConsensusRequest`. `POST /tx` accepts a signed transaction and still rejects `mining_claim` at parse time.
- **Website.** Marketing pages set `connect-src 'none'` and `script-src 'self'`. The phone wallet sets `default-src 'none'` and `connect-src 'none'`, with subresource integrity and a content-hashed service worker that only caches listed same-origin GET responses (`website/app/sw.js`, `tools/pwa-wallet/test-core.mjs`).
- **Phone wallet.** Vault is scrypt (N=2^17, r=8, p=1) plus AES-256-GCM. The recovery phrase is not stored as a long-lived string. IndexedDB write path refuses anything that is not an encrypted vault. Link signing accepts only the fixed ZYRON NODE testnet message. The UI does not query an RPC and does not display a balance.
- **Hub sign-in.** No cookies. The browser holds a random secret; the bot delivers a one-time code in Telegram; five wrong codes burn the request. `web_profile` runs in a read-only transaction and does not grant points (`telegram-game/src/zyron_node/web_login.py`). Hub rendering uses `textContent`.
- **Game points.** Amounts are computed on the server. Ledger grants use an idempotency key that includes the player id. `DEV_AUTH_BYPASS` and the test clock cannot be on when `ENVIRONMENT=production`. Forwarded client IPs are ignored unless the TCP peer is in an explicit proxy list (`client_ip.py`). `TRUST_PROXY=1` with no list is rejected.
- **Trading.** `npm run trading:preflight` is tested to refuse while the launch plan gates are false.

## Recommended fix order

1. Leave `publicTestnetActivationAllowed`, `mainnetActivationAllowed`, `publicMiningActivated`, and `websiteTradingActivated` false.
2. When a genesis is actually prepared: `launchProfile: "fixed-supply-v1"`, four real role addresses supplied by the owner, `npm run tokenomics:check` exit 0, genesis file SHA-256 and release commit written down, `activityOracleThreshold` set with independent oracle keys, and at least four independently operated validators. Do not paste those addresses or keys into this repository from a review.
3. Independent consensus, cryptography, and oracle review before any value. A green CI run is not that review.
4. In a separate change, rebuild `website/app/vendor` so `@noble/curves` matches L1 2.4.0, then re-run the PWA wallet tests. Confirm transfer signatures still match the L1 verifier before merging.
5. Only if Zyron Points are later redeemable for ZYN: reject same-network referrals before payout, and shorten the Telegram `initData` lifetime, then review the game again.

## What must stay blocked before any value-bearing mainnet

All of the following stay closed until the evidence exists outside this review:

- `mainnetActivationAllowed` and `publicTestnetActivationAllowed`
- Public mining and any miner download
- A published mainnet chain ID, RPC, explorer, faucet, or bootstrap list
- Trading, a quote asset, and any buy or sell control that can take funds
- A genesis that has not passed `tokenomics:check` with the owner’s four role addresses
- A single activity-oracle key on a funded pool
- A validator set that cannot tolerate a faulty validator (do not launch v6 with fewer than four)
- Reuse of open-testnet keys, the testnet state secret, or the faucet key
- The claim that this review, CI, or the launch-authorization file is an audit

The legacy Python chain remains a compatibility testnet. Its new check that a current-version block’s float timestamp matches `timestamp_ms` (`zyron/blockchain.py`) does not change the canonical L1.
