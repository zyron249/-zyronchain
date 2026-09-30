# ZyronChain cryptography review — 2026-09-30

**Nature of this document:** internal, AI-assisted engineering review (automated executor). It is **not** an independent audit, not a human sign-off, and must not be cited as "audit passed". ZC-AUD-20260928-010 (no independent review) still applies.

- Branch: `audit/crypto-review-20260930`, based on `audit/security-20260928` @ `da8924a` (the stack #903 → #904 → security audit). Base chosen because the open prior findings (AUD-006/008/009) are on that stack.
- `main` @ `8794b4e` (unchanged since the prior audit). Draft PRs reviewed read-only: #913 (`pr-913` @ `6fc97e8`), #914 (`pr-914` @ `f0eeb97`, 4 commits on main).
- Suggestions for #913 live on a separate local branch `audit/crypto-review-20260930-pr913-suggestions` (based on `pr-913`), so #913 is not duplicated here.
- Scope: `l1/` (canonical chain), `telegram-game/` (ZYRON NODE Mini App + bot), `website/` (key/signing copy only), legacy Python `zyron/` (quarantined).
- Owner's authoritative tokenomics spec (2026-09-30): 50,000,000 ZYN total, **all allocated at genesis**: 5M founder (10%), 20M public distribution (40%), 20M permanent-liquidity reserve (40%), 5M ecosystem/community (10%). Mining is shut down.

## Method (3 passes)

1. **Primitive usage:** every sign/verify call site, hashing, canonical encoding, Merkle/SMT construction, key generation, keystore, token/HMAC comparisons.
2. **Protocol binding:** what each signature covers (domain, chainId, height/round, hash), replay protection, quorum counting, supply/mint paths vs. the 50M spec, #913/#914.
3. **Adversarial proofs:** each finding below has a test that fails before the fix (or a characterization/probe for remaining items). Prior tests were not trusted; new tests restate constants independently.

## Findings

| ID | Sev | Title | Status |
|---|---|---|---|
| ZC-CRY-20260930-001 | MEDIUM | Consensus RPC routes fail open without bound auth (AUD-008) incl. CLI same-host-proxy variant | **FIXED** |
| ZC-CRY-20260930-002 | HIGH | Mining mint path still live at protocol v5 for any genesis < 50M; retirement relied only on "remaining = 0" | **PARTIALLY FIXED** (explicit fail-closed for full-cap genesis; unconditional retirement needs a consensus decision) |
| ZC-CRY-20260930-003 | LOW | Tx Merkle odd-node duplication (CVE-2012-2459 class); header does not commit to tx count | **FIXED** (envelope), root format unchanged |
| ZC-CRY-20260930-004 | LOW | Telegram initData: non-ASCII `hash` → TypeError → HTTP 500, skips auth-fail limiter | **FIXED** |
| ZC-CRY-20260930-005 | INFO | Protocol v1/v2 consensus signatures are not domain-separated | ACCEPTED (payload shapes proven disjoint; v3+ domain-tagged) |
| ZC-CRY-20260930-006 | MEDIUM | #913 `assertFixedSupplyGenesis` accepts activityPool = founder / liquidity reserve → oracle can drain it | **FIX on suggestion branch** (not in #913 yet) |
| ZC-CRY-20260930-007 | HIGH (launch blocker) | #913 founder vesting and "permanent" liquidity are not enforced on-chain | REMAINING (acknowledged in #913 docs) |
| ZC-CRY-20260930-008 | LOW | #913 vesting is block-height based; consensus does not enforce a 30 s cadence | REMAINING (design) |
| ZC-CRY-20260930-009 | INFO | Prior audit artifacts labelled "Independent … auditor" | **FIXED** (labels corrected) |
| ZC-CRY-20260930-010 | MEDIUM | Single activity-oracle key has unilateral, uncapped control of the activityPool balance | REMAINING (custody/design) |
| ZC-CRY-20260930-011 | LOW | Stale mining copy (website, Mini-App-adjacent docs, whitepaper, public-testnet governance input) | REMAINING (copy/product) |
| ZC-CRY-20260930-012 | INFO | Legacy Python chain: SHA-1 v1 sigs, no address checksum, non-BIP32 key derivation | ACCEPTED (quarantined, 410) |

### 001 — MEDIUM — consensus routes fail open (closes ZC-AUD-20260928-008)
- **Proof:** `createRpcServer` without `peerAuthToken`/`trustedPeerPublicKeys` served `/proposal/prepare` etc. to any peer. Worse, the CLI's `assertSafeRpcBinding("127.0.0.1", false, true)` accepted a loopback bind **behind a trusted same-host proxy** with no consensus auth, so public HTTPS traffic forwarded over loopback reached consensus handlers. `l1/test/crypto-review-rpc-consensus-auth.test.ts`: 3/6 failed before the fix.
- **Fix:** in `createRpcServer`, when no consensus auth is bound, consensus routes (per `classifyRpcRoute`) are served only to a **direct loopback** caller on a server **without trusted proxies**; otherwise 401 before body read. Explicit escape hatch `allowUnauthenticatedConsensus: true` for embedders that authenticate elsewhere. `assertSafeRpcBinding` now rejects trusted-proxy + no consensus auth. Local devnets (direct loopback) unchanged.

### 002 — HIGH — mining still mintable; retirement was implicit
- **Proof:** existing `l1/test/mining.test.ts` ("protocol v5 activates, finalizes real proof-of-work issuance…") mints 6.25 ZYN on a small genesis — the mint path is live code. `config/public-testnet-governance-input.candidate.json` still declares `protocolV5ActivationPolicy: quorum-delayed-upgrade` and `public-testnet-governance.ts` reports a `miningBudgetAtoms`. Under the owner's spec (full 50M at genesis) the schedule returns 0, which **was** already effective (verified: pre-fix, a PoW-valid 1-atom claim was rejected with "maximum historical issuance has been reached"), but nothing in consensus enforces genesis = 50M, and the rejection depended on schedule arithmetic.
- **Fix (this branch):** `assertMiningClaimContext` (the single gate used by mempool admission, pending selection, block production and block validation, legacy and State-v2) now (a) rejects every claim **before schedule/PoW evaluation** when genesis supply ≥ MAX_SUPPLY ("Mining is retired…"), and (b) re-checks `genesis + cumulativeIssued(claimCount) + reward ≤ MAX_SUPPLY_ATOMS` from consensus counters (also mitigates AUD-006). Consensus-equivalent for existing chains. Message keeps "maximum historical issuance has been reached" so #913's test still passes after merge.
- **Tests:** `l1/test/crypto-review-fixed-supply.test.ts` — atom-exact 10/40/40/10 = 5e15 (BigInt), +1 atom genesis rejected, reward 0 for claim counts up to 2^53-2, MAX-1 genesis admits exactly 1 atom then 0 (off-by-one boundary), legacy ledger refuses a 1-atom mint at full supply, and a protocol-v5 chain with the spec genesis rejects a **PoW-valid** 1-atom claim via mempool, selection, produceBlock and validatePending, after a fee burn (supply < cap does not reopen issuance), and after trusted-snapshot restart (`genesisSupplyAtoms` is re-derived from genesis, not current balances). 2/7 failed before the explicit guard (message-level; the mint was already refused).
- **Remaining (needs owner decision):** unconditional retirement (reject `mining_claim` for every genesis / remove v5 mining) is a consensus-rule change that breaks the existing mining rehearsal tests/tooling (`scripts/mine.mjs`, `npm run mine:local`, 6 mining test files) and the public-testnet governance model; it should land together with #913 (which currently keeps mining code "for local/historical rehearsal").

### 003 — LOW — Merkle duplication
- **Proof:** `merkleRoot([a,b,c]) === merkleRoot([a,b,c,c])` and `[a..f]` vs `[a..f,e,f]`; the header has no tx count, so a relay-mutated block keeps hash, proposer signature and attestations. State transition already rejected it ("Duplicate transaction in block"), and proposals are fully executed before `RoundProposalStore.save`, so no exploit was found; but `validateBlockEnvelope` accepted it. `l1/test/crypto-review-merkle-duplicate.test.ts` failed before the fix.
- **Fix:** envelope-level duplicate-txid rejection before the Merkle check. **Recommend** at the next protocol version: leaf/node domain tags (`0x00`/`0x01`), no odd duplication (promote), and tx count in the header.

### 004 — LOW — Telegram initData hash handling
- **Proof:** `hmac.compare_digest(str, str)` raises TypeError for non-ASCII; a 64-char non-ASCII `hash` produced HTTP 500 via the generic handler and bypassed `ip:*:authfail` rate limiting in `api.authorize`. `telegram-game/tests/test_crypto_review_init_data.py` 2/4 failed before.
- **Fix:** require lowercase hex before comparing; compare ASCII bytes. HMAC construction itself (`HMAC("WebAppData", token)` → HMAC over sorted `k=v` lines, all fields but `hash`), constant-time compare, auth_date freshness/skew, duplicate-key rejection were verified correct.

### 005 — INFO — v1/v2 undomained signatures
Protocol ≤ 2 blocks/votes/transactions sign bare canonical JSON with the validator key. `l1/test/crypto-review-signatures.test.ts` proves the signed payload key-sets (header, attestation, skip, prepare, view-change, transfer, both approvals) are pairwise distinct, so no cross-message confusion exists today. v3+ uses `{domain, payload}`. Keep new message types domain-tagged.

### 006 — MEDIUM — #913 activity pool not pinned
- **Proof (`/tmp/probe913.mjs` against `pr-913`):** a spec genesis with `activityPool = founder` or `= liquidityReserve` passes `assertFixedSupplyGenesis`, and a single oracle-signed `activity_settlement` moving the entire 5M/20M to an arbitrary address is admitted to the mempool. That bypasses founder vesting / drains "permanent" liquidity.
- **Fix (suggestion branch `audit/crypto-review-20260930-pr913-suggestions` @ `e67c1b8`):** reject founder/liquidity as pool; accept only publicDistribution or ecosystemReserve (which one funds the activity airdrop is an owner decision — #913's own test uses ecosystemReserve). Test fails before, passes after.

### 007 — HIGH (launch blocker) — vesting / permanent liquidity not enforced
`founder-vesting.ts` is arithmetic only (#913 states it is not wired into authorization). At genesis the founder key can spend all 5M and the liquidity key all 20M. Vesting math itself checked: 0 through cliff height, floor-linear BigInt, exact total at end, monotonic. Needs a protocol-level lock or audited custody before any value-bearing launch.

### 008 — LOW — vesting by block height
`FOUNDER_CLIFF_BLOCKS = 365 × 2880` assumes 30 s blocks; consensus only requires increasing timestamps (≤ +120 s future), so faster blocks unlock earlier. Prefer finalized-timestamp-based vesting or enforce a minimum block interval.

### 009 — INFO — mislabelled prior audit
`docs/audit/FINDINGS.json`, `ZYRONCHAIN_SECURITY_AUDIT_REPORT.md`, `ARCHITECTURE_MAP.md` described the 2026-09-28 pass as "independent". Corrected to "internal automated review; not an independent audit". AUD-008 marked fixed, AUD-006 mitigated.

### 010 — MEDIUM — activity oracle custody
Any key in `genesis.activityOracles` can, with one signature, move the entire activityPool balance (up to 10,000 entries, each up to MAX) once per epoch; no pool-key co-signature, no per-epoch cap, no multisig. Under the fixed-supply plan this is 5–20M ZYN behind one hot key. Recommend a per-epoch cap, threshold oracle signatures, or a timelocked pool.

### 011 — LOW — stale mining copy
- `website/index.html:150` ("Protocol-v5 mining introduces permissionless Proof-of-Work claims for ZYN issuance"), `:282` status row "Public mining — Activation gated", `:318` nav "Mining Launchpad" → `website/mining.html`; #914 keeps the nav link and status row.
- `WHITEPAPER.md` §issuance (lines ~36–48) describes v5 mining; `README.md:33,80`; `l1/README.md:59`; `l1/MINING.md`; `docs/PUBLIC_LAUNCH_CHECKLIST.md` "public mining".
- `l1/config/public-testnet-governance-input.candidate.json` `protocolV5ActivationPolicy`.
- Mini App (`telegram-game/frontend/app.js:646`) already says "This does not mine ZYN." — OK.
Not edited here (product copy; #914 scope).

### 012 — INFO — legacy Python
Quarantined (`ZYRON_LEGACY_PUBLIC_QUARANTINE` → 410). v1 txs use SHA-1-padded ECDSA with normalized S; v3 enforces low-S and canonical JSON. Addresses `ZYN`+sha256[:40] have no checksum (same in L1). Wallet key = sha256(BIP39 seed), not BIP32.

## Verified OK (no change)
- `@noble/curves` 2.3.0: secp256k1 `sign` RFC6979 + low-S; `verify` defaults `lowS: true`, `prehash: sha256`; r,s ∈ [1,n-1]; public keys decoded and on-curve checked. High-S twin with recomputed txid is rejected, so txid (which covers the signature) is not malleable.
- All tx/vote/record hex fields are strict lowercase fixed-length (`assertHex`), so `Buffer.from(hex)` leniency is unreachable on consensus paths.
- chainId in every tx/vote payload; txs bound to `addressFromPublicKey(publicKey) === sender` (activity settlements are authorized by oracle key + `sender === activityPool`); per-account sequential nonces; amount+fee safe-integer checks.
- Canonical JSON: sorted UTF-16 keys, safe-integer numbers only, depth/cycle bounds.
- State-v2 SMT: domain-separated leaf/empty/branch/key/value hashes, fixed-length inputs, full-depth proofs.
- Quorum: floor(2N/3)+1; attestation/prepare/skip certificates dedup by validator and require the registered public key; view-change certificates count one vote per validator and only proven locks.
- Keys: `crypto.randomBytes` + `isValidSecretKey`; keystore scrypt (N=2^15, r=8, p=1) + AES-256-GCM with pubkey/address AAD, zeroization; bearer tokens compared with `timingSafeEqual`; Telegram admin token via `hmac.compare_digest`.
- Secrets scan (PEM keys, Telegram bot tokens, GitHub/AWS/Slack tokens, hex private-key JSON): no hits outside obvious test constants.
- #913 amounts: 500000000000000 / 2000000000000000 / 2000000000000000 / 500000000000000 atoms = 5e15 exactly; #914 homepage copy matches (5M/20M/20M/5M, 0 mining headroom, trading disabled button with no form/fetch).

## Status update — owner decisions (2026-09-30, later the same day)

The owner decided: (1) the activity airdrop is paid **only** from the 5M ecosystem/community pool; (2) mining is **retired for every genesis**. Implemented on unpushed local branches (not on main, not in #913/#914 yet):

- **ZC-CRY-20260930-006 → FIXED on `audit/crypto-review-20260930-pr913-suggestions` (`5a752a1`).** `assertFixedSupplyGenesis` requires `activityPool == ecosystemReserve` and explicitly rejects founder, public-distribution and liquidity addresses. Consensus also makes the activity pool outflow-only: a transfer or settlement entry that credits it is rejected in mempool admission, `LedgerState.apply` and `applyStateV2Transaction`, so cumulative airdrops can never exceed 5,000,000 ZYN. Proof: `l1/test/activity-airdrop-cap.test.ts` (2/2 failed before the inflow ban, pass after) settles to exactly 5M and shows the next atom and any refill are rejected on every path.
- **ZC-CRY-20260930-002 → FIXED on the same branch (`2edc6b0`).** `mining_claim` is rejected explicitly and fail-closed for every genesis and protocol version: shape validation, mempool admission, `Mempool.add`, pending selection/block production, block and proposal validation, and both state appliers. `miningRewardAtoms` always returns 0. `scripts/mine.mjs` and `local-devnet --local-v5` (`npm run mine:local`) exit non-zero. Every mining test was converted to a rejection assertion (none deleted). BREAKING: chain data containing a finalized mining claim no longer replays.
- **ZC-CRY-20260930-011 → ADDRESSED on two branches.** Website copy is on `audit/crypto-review-20260930-copy-cleanup` (based on #914, `2c587df`): mining advertising and the Mining Launchpad links are removed, and `mining.html` is kept as a retired `noindex` record. README, WHITEPAPER, `l1/MINING.md`, `docs/MINING.md`, `l1/README.md`, PUBLIC_TEST, PUBLIC_LAUNCH_CHECKLIST and CONTRIBUTING are on the #913 suggestion branch (`2edc6b0`, `6fbc1e5`), because the website release-pin CI rejects website PRs that also touch `l1/**` or WHITEPAPER. Still open: the #903 public-testnet governance mining model and the miner packaging/release tooling (see below).
- Merge-check caveat: this branch (which carries the #903/#904 stack) plus the suggestion branch gives 740/750. The 10 failures are mining-positive tests that only exist on this stack and must be converted to rejection tests when the branches are integrated: `audit-supply-economics`, `consensus-extended-qualification` ×2, `crypto-review-fixed-supply` ×2, `mining-economics-pin`, `public-testnet-deployment`, `public-testnet-provisioning`, `public-testnet-readiness` and `supply-invariant`.

## Remaining open items (from 2026-09-28 plus this review)
- AUD-007 HIGH (N ≤ 3 has f = 0) — operational.
- AUD-009 MEDIUM (unique-hash lock durability) — not addressed in this pass.
- AUD-010 INFO — independent consensus review still required.
- ZC-CRY-002 / 006 / 011: implemented on unpushed suggestion branches (see status update); they still need to be merged into #913/#914 and, for the #903 stack, the mining tests and governance mining model still need converting. 007, 008 and 010 remain owner/design decisions.

## Test evidence (box-local, ET)

Note: the suggestion branch is not pushed; the merge check was a throwaway local merge, not a branch.
| Suite | Before | After |
|---|---|---|
| `l1` `npm test` (audit/crypto-review-20260930) | 711/711 | 732/732 |
| `l1` merge check (this branch + #913 + suggestion) | — | 748/748 |
| `l1` #913 + suggestion branch alone | — | 623/623 |
| root `pytest` (legacy) | 58 passed | 58 passed |
| `telegram-game` `pytest` | 30 passed, 16 skipped | 34 passed, 16 skipped (skips need Postgres) |
| `npm run typecheck` / `npm audit` | clean / 0 vulns | clean / 0 vulns |
