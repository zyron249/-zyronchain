# Differentiating features: threat model, feasibility and priority

Status: **design proposal**. Docs only. Nothing in this document is implemented unless it says "shipped". Based on `origin/main` at `4a92fb7c` (after #1110 and #1114).

Inputs: the Security threat-model input, the wallet feasibility note (features 3, 6, 7) and the protocol feasibility note (features 1, 2, 6). All security input so far is AI review, not an audit. External human review is still required where this document says so.

## Ground rules for every feature

- **Supply is fixed at 50,000,000 ZYN** (`MAX_SUPPLY_ATOMS`, `l1/src/types.ts`). Mining is retired; consensus rejects every `mining_claim`.
- **No feature touches supply or allocations.** No feature adds a credit path. Every new state transition is a move between existing balances, or into an escrow bucket that is counted in `totalSupplyAtoms()`. The only supply reduction stays the existing fee burn.
- **Every consensus feature ships with activation off** (activation flags false, no public-testnet or mainnet activation), following the `feePolicy` pattern in [FEE_POLICY_V1.md](../FEE_POLICY_V1.md), and needs **owner review** before activation.
- Today `SUPPORTED_PROTOCOL_VERSIONS = {1, 2, 3, 5, 6}` (`l1/src/chain.ts`). New consensus rules land behind a new protocol version, activated by a `protocol_upgrade` transaction and gated in `assertTransactionVersionForProtocol`.
- **No supply changes anywhere.** None of the features or defaults below mints, burns (beyond the existing fee burn), reallocates or unlocks any ZYN.
- Effort figures below are estimates from the feasibility notes, not commitments.

## Decided defaults

These defaults are **set by the project architect**. They are **not owner-approved**: each remains subject to the owner's review and final go.

1. **Cancel authority**: only the sender may cancel, and only during the delay window. An opt-in guardian co-cancel may come later and is never on by default. Validators and the team never get cancel or freeze power.
2. **Delay and threshold**: a default delay of 24 hours for sends of 1,000 ZYN or more. Users may tighten the delay or threshold at any time; loosening either takes effect only after the current delay has elapsed.
3. **Guardians**: 3-of-5 by default, minimum 2-of-3, with a 72-hour recovery time lock during which the existing key can veto. Guardian changes are time-locked too. Validator keys and locked allocation addresses are excluded.
4. **State-v2 on the wallet chain**: testnet only, activation off, and only after the wallet-side features ship plus a 30-day testnet soak. State-v2 for the wallet chain is its own future decision.
5. **Supply verifier**: recompute from genesis by full replay of blocks, against the genesis hash pinned in the repo and docs. As a cross-check, compare headers from at least 2 endpoints. Today those endpoints are project-operated, not independent, so the cross-check detects inconsistency but is not independent attestation. Fail closed on any mismatch and reconcile every bucket to exactly 50,000,000 ZYN.
6. **Intents**: 6B goes ahead after 6A. Wallets sign only known transaction types (transfer, stake/unstake, delayed-send/cancel) and refuse anything unknown. Note: stake/unstake and delayed-send/cancel kinds do not exist on main today; only transfer is wallet-signable now, and each new kind enters the allowlist only when it exists and has golden vectors.
7. **Rollout**: wallet-only features (7, 5, 6A and the wallet-side delayed send) ship normally on the testnet and PWA. Chain features stay activation-off, go to testnet first and soak for 30 days. Any mainnet activation needs the owner's final go.

## Priority order (agreed)

| # | Feature | Consensus change | Status |
|---|---|---|---|
| 1 | 7. Wallet send warnings: lookalike detection | None | Base warnings shipped in #1110; lookalike remains |
| 2 | 5. Public fixed-supply verifier | None | Proposed |
| 3 | 6A. Shared fail-closed intent renderer | None | Proposed |
| 4 | 1. Reversible large transfers | Wallet step: none. Escrow step: yes (protocol v7) | Proposed |
| 5 | 3. Wallet light-client verification via proof bundle | Headers: none. State proofs: need State-v2 on the wallet chain | Proposed |
| 6 | 6B. `intentHash` in signing payload v3 | Yes | Proposed |
| 7 | 2. Seedless recovery | Yes | Last; own spec and external human review first |
| - | 4. Fee v1 | Yes (genesis opt-in) | Shipped (#1086), not activated |

---

## 1. Feature 7: wallet send warnings (lookalike detection)

**Shipped in #1110** (`website/app/zyron-wallet-core.js`, `website/app/app.js`): blocking self-send warning; first-time-recipient warning from the encrypted `sent` history; warning at or above a user-set threshold; address book, history and threshold sealed with AES-GCM in vault v2 (v1→v2 migration with a rollback copy); warnings need a separate acknowledgement before Sign is enabled. Checksum input validation already exists ([ADDRESS_CHECKSUM.md](../ADDRESS_CHECKSUM.md)).

**Remaining work**
- Lookalike detection: compare the receiver with contacts and `sent`. Flag when a prefix and suffix match but the full address differs (or the edit distance is small). Show both addresses with differing characters highlighted, as a distinct warning with its own acknowledgement.
- Full-checksum comparison and checksummed, grouped display everywhere: review screen, receive QR text, contact list and signed-transfer view.

**Threat model**: address poisoning and clipboard substitution with a vanity address that matches the visible prefix/suffix. The address book must stay local-only and integrity-protected (already sealed in vault v2). `sent` holds only addresses the user signed for, so it cannot be poisoned from outside, but a lookalike that is already in history must still warn. Warning fatigue: keep lookalike warnings rare and visually distinct; cap comparisons for large books.

**Feasibility**: pure local logic, no chain dependency. Estimated S (2-3 days) with tests using crafted prefix/suffix collisions.

**Rollout**: wallet-only; ships normally on testnet and PWA (decided default 7).

**Still open**: prefix/suffix lengths and edit-distance rule; whether a lookalike warning is blocking or acknowledge-only.

## 2. Feature 5: public fixed-supply verifier

**Goal**: a public tool anyone can run that **recomputes** supply from genesis and blocks (or a signed snapshot) rather than trusting a node's reported number, and reconciles every bucket (all balances, allocation-locked amounts, any future escrow, burned fees) to exactly 50,000,000 ZYN.

**What exists**: `MAX_SUPPLY_ATOMS`, `LedgerState.totalSupplyAtoms()`, genesis checks, and tests (`fixed-supply-genesis-invariants.test.ts`, `fixed-supply-tokenomics.test.ts`, `allocation-lock-bypass-paths.test.ts`). There is no standalone public verifier on main today.

**Threat model**: a lying node or gateway reporting a fabricated total; a tampered verifier binary (hence a reproducible build with published hashes); silent drift where a bucket is omitted. Snapshot input must be signed and bound to a genesis hash.

**Feasibility**: no consensus change. Reuses existing state-apply code. Must be extended when new buckets (escrow in feature 1) are added.

**Decided default (5)**: full replay from genesis against the pinned genesis hash, header cross-check against at least 2 endpoints (project-operated today, not independent), fail closed on mismatch, every bucket reconciled to exactly 50M. Signed snapshots are not the default trust root.

**Still open**: where reproducible-build hashes are published.

## 3. Feature 6A: shared fail-closed intent renderer

**What exists**: transfers are fully structured (`l1/src/types.ts`); v2 signs `{domain: "zyronchain/transaction/<kind>/v2", payload}` (`l1/src/transaction.ts`), so the kind is bound to the signature. The PWA and the Snap sign transfers only and render every signed field. Other kinds (activity settlement, validator update, oracle governance, protocol upgrade) are not wallet-signable today. Blind signing is not a current risk for transfers.

**Proposal**: one versioned renderer module shared by the wallet, CLI, Snap and remote signer (`l1/src/remote-signer-service.ts`). Per `kind` it lists which fields are shown and how (atoms → ZYN plus atoms, checksummed address). **Fail closed**: an unknown kind or unknown field means refuse to sign. Golden vectors derived from l1 keep renderers from drifting. **No consensus change.**

**Threat model**: renderer bugs that hide a field; homoglyph or bidi characters in any text (ASCII only); version drift between signers; displayed text not matching signed bytes (golden vectors must round-trip the exact `amountAtoms`/`feeAtoms`).

**Feasibility**: estimated S-M (2-4 days wallet side; 4-6 days including CLI and signer).

**Decided default (6)**: signable allowlist is transfer, stake/unstake and delayed-send/cancel, added only as each kind exists; everything else is refused. Wallet-only rollout (default 7).

## 4. Feature 1: reversible large transfers

**Step 1, wallet-side delayed broadcast (no consensus change)**: sign now, broadcast after a delay; cancel = discard the signed transaction. Honest scope: protects against user mistakes only, not a thief holding the key. A signed transaction remains valid until its nonce is used, so "cancel" must be documented as "do not broadcast", and the wallet should advance the nonce or warn if the signed bytes left the device.

**Step 2, opt-in on-chain escrow at protocol v7 (consensus, activation off)**
- Per-account opt-in policy (threshold, delay). Over-threshold transfers debit the sender into a `pendingTransfers` escrow instead of crediting the receiver.
- New kinds: `transfer_cancel` (before release) and a permissionless `transfer_release` (or bounded auto-release at block apply).
- New kinds rejected below v7. State root, snapshots and light-client proofs need versioning.
- **Invariant**: `sum(balances) + sum(escrow) == genesis supply - burned fees`. Exactly one of release or refund per entry, enforced by deleting it. Property tests over random transfer/cancel/release sequences, double-release and double-cancel tests, snapshot round-trip, and tests that allocation-locked funds cannot be escrowed out early.
- Estimated 10-15 engineering days.

**Threat model**: if the sending key also holds cancel authority, a thief can cancel too, so it covers mistakes and recipient-side compromise only; split-transfer evasion of the threshold (rolling-window cap); state bloat griefing (per-sender caps, fees); proposer timestamp drift shifting release; receivers and exchanges must treat pending funds as unconfirmed (pending/final API).

**Decided defaults (1, 2)**: sender-only cancel during the window; no validator or team cancel/freeze power; optional guardian co-cancel later, opt-in, never default. 24h delay at 1,000 ZYN or more; tightening is immediate, loosening waits out the current delay. The escrow step stays activation-off, testnet first, 30-day soak (default 7).

**Still open**: per-account cap and rolling-window parameters; auto-release vs release transaction.

## 5. Feature 3: wallet light-client verification via an imported proof bundle

**What exists**: `website/verify/light-client.js` (browser port of `l1/src/light-client.ts`) verifies headers, commits, v6 certificates and state proofs, with tests. The PWA keeps `connect-src 'none'`.

**Gap is data, not code**: the gateway does not serve State-v2 inclusion/non-membership proofs or validator-set transition proofs, and the PWA's wallet chain `zyron-wallet-testnet-1` runs protocol 1, which has no sparse state root (`protocolUsesStateV2`, `l1/src/chain.ts`).

**Proposal**: `/verify/` fetches and verifies, then exports a proof bundle (anchor, headers, certificates, later state proofs) that the PWA imports by file and re-verifies locally. The CSP is not relaxed. **Headers only now**, labelled "headers verified to anchor H". Balance/nonce proofs need **State-v2 on the wallet chain and gateway proof endpoints**.

**Threat model**: pinned genesis/checkpoint anchor that must be updated on resets; validator-set transition proofs; untrusted bundle input (strict validation, proof size caps); users over-reading "verified".

**Feasibility**: headers-only M (4-6 days); state proofs +M (3-5 days) once served.

**Decided default (4)**: State-v2 on the wallet chain is testnet only, activation off, after the wallet-side features ship plus a 30-day soak.

**Still open**: anchor pin and update process.

## 6. Feature 6B: `intentHash` in signing payload v3

**Proposal**: a new transaction version 3 whose signing payload includes `intentHash = hash(rendered text, renderer version)`; validators recompute and reject mismatches. Signing payloads are v2 today. The renderer becomes consensus-critical: byte-exact, locale-free, integer-only BigInt formatting.

**Threat model**: renderer divergence becomes a consensus fault; versioning of renderer and payload; same homoglyph/bidi rules as 6A.

**Feasibility**: depends on 6A; estimated +6-8 days. New protocol version, activation off, owner review.

**Decided default (6)**: 6B goes ahead after 6A, activation off, testnet first with a 30-day soak.

## 7. Feature 2: seedless recovery (last)

Ships only behind **its own spec and external human review**.

**Shape**: today address = hash(pubkey), one permanent key. Recovery needs an `authKey` per account, guardian configuration, and time-locked `recovery_initiate` / `recovery_cancel` / `recovery_execute` transactions. Signature verification changes for every transaction, so this is consensus-critical. Simpler v1 options: off-chain Shamir-split keystore backup (no consensus change), or a single recovery key with a time lock.

**Exclusions**: validator keys and locked genesis allocation addresses cannot configure recovery. Rotation must never reset allocation locks.

**Threat model**: guardian collusion and sybil guardians (mitigated by time lock plus owner veto); offline owner with malicious guardians; approval replay (bind chainId and nonce in every approval); recovery spam (bond, rate limit); mempool must drop transactions signed by a rotated key.

**Feasibility**: estimated 20-30 engineering days without passkeys; +10-15 with P-256 passkeys.

**Decided default (3)**: 3-of-5 default, minimum 2-of-3, 72h time lock with existing-key veto, time-locked guardian changes, validator keys and locked allocation addresses excluded.

**Still open**: guardian bond and rate limits; passkey support.

## Feature 4: fee v1 (shipped)

Implemented in #1086, **not activated** ([FEE_POLICY_V1.md](../FEE_POLICY_V1.md)): a fixed, predictable fee split between burn and producer. Describe it as **"no fee auction"**, not "no MEV": a block producer can still order transactions in its own block.

## Open owner decisions (summary)

Every decided default above still needs the owner's review and final go. Beyond those, these remain open:

1. Lookalike rule parameters and whether the warning blocks.
2. Reversible-transfer per-account cap, rolling window, and auto-release vs release transaction.
3. Guardian bond and rate limits; passkey support.
4. Light-client anchor pin and update process.
5. Where reproducible-build hashes for the supply verifier are published.
6. Activation of any consensus feature, and any mainnet activation (owner's final go).
