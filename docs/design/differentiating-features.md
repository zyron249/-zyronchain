# Differentiating features: threat model, feasibility and priority

Status: **design proposal**. Docs only. Nothing in this document is implemented unless it says "shipped". Based on `origin/main` at `4a92fb7c` (after #1110, #1113, #1114).

Inputs: the Security threat-model input, the wallet feasibility note (features 3, 6, 7) and the protocol feasibility note (features 1, 2, 6). All security input so far is AI review, not an audit. External human review is still required where this document says so.

## Ground rules for every feature

- **Supply is fixed at 50,000,000 ZYN** (`MAX_SUPPLY_ATOMS`, `l1/src/types.ts`). Mining is retired; consensus rejects every `mining_claim`.
- **No feature touches supply or allocations.** No feature adds a credit path. Every new state transition is a move between existing balances, or into an escrow bucket that is counted in `totalSupplyAtoms()`. The only supply reduction stays the existing fee burn.
- **Every consensus feature ships with activation off** (activation flags false, no public-testnet or mainnet activation), following the `feePolicy` pattern in [FEE_POLICY_V1.md](../FEE_POLICY_V1.md), and needs **owner review** before activation.
- Today `SUPPORTED_PROTOCOL_VERSIONS = {1, 2, 3, 5, 6}` (`l1/src/chain.ts`). New consensus rules land behind a new protocol version, activated by a `protocol_upgrade` transaction and gated in `assertTransactionVersionForProtocol`.
- Effort figures below are estimates from the feasibility notes, not commitments.

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

**Owner decisions**: prefix/suffix lengths and edit-distance rule; whether a lookalike warning is blocking or acknowledge-only.

## 2. Feature 5: public fixed-supply verifier

**Goal**: a public tool anyone can run that **recomputes** supply from genesis and blocks (or a signed snapshot) rather than trusting a node's reported number, and reconciles every bucket (all balances, allocation-locked amounts, any future escrow, burned fees) to exactly 50,000,000 ZYN.

**What exists**: `MAX_SUPPLY_ATOMS`, `LedgerState.totalSupplyAtoms()`, genesis checks, and tests (`fixed-supply-genesis-invariants.test.ts`, `fixed-supply-tokenomics.test.ts`, `allocation-lock-bypass-paths.test.ts`). There is no standalone public verifier on main today.

**Threat model**: a lying node or gateway reporting a fabricated total; a tampered verifier binary (hence a reproducible build with published hashes); silent drift where a bucket is omitted. Snapshot input must be signed and bound to a genesis hash.

**Feasibility**: no consensus change. Reuses existing state-apply code. Must be extended when new buckets (escrow in feature 1) are added.

**Owner decisions**: whether signed snapshots are accepted as a starting point or only full replay from genesis; who signs snapshots; where reproducible-build hashes are published.

## 3. Feature 6A: shared fail-closed intent renderer

**What exists**: transfers are fully structured (`l1/src/types.ts`); v2 signs `{domain: "zyronchain/transaction/<kind>/v2", payload}` (`l1/src/transaction.ts`), so the kind is bound to the signature. The PWA and the Snap sign transfers only and render every signed field. Other kinds (activity settlement, validator update, oracle governance, protocol upgrade) are not wallet-signable today. Blind signing is not a current risk for transfers.

**Proposal**: one versioned renderer module shared by the wallet, CLI, Snap and remote signer (`l1/src/remote-signer-service.ts`). Per `kind` it lists which fields are shown and how (atoms → ZYN plus atoms, checksummed address). **Fail closed**: an unknown kind or unknown field means refuse to sign. Golden vectors derived from l1 keep renderers from drifting. **No consensus change.**

**Threat model**: renderer bugs that hide a field; homoglyph or bidi characters in any text (ASCII only); version drift between signers; displayed text not matching signed bytes (golden vectors must round-trip the exact `amountAtoms`/`feeAtoms`).

**Feasibility**: estimated S-M (2-4 days wallet side; 4-6 days including CLI and signer).

**Owner decisions**: which kinds, if any, become signable beyond transfers.

## 4. Feature 1: reversible large transfers

**Step 1, wallet-side delayed broadcast (no consensus change)**: sign now, broadcast after a delay; cancel = discard the signed transaction. Honest scope: protects against user mistakes only, not a thief holding the key. A signed transaction remains valid until its nonce is used, so "cancel" must be documented as "do not broadcast", and the wallet should advance the nonce or warn if the signed bytes left the device.

**Step 2, opt-in on-chain escrow at protocol v7 (consensus, activation off)**
- Per-account opt-in policy (threshold, delay). Over-threshold transfers debit the sender into a `pendingTransfers` escrow instead of crediting the receiver.
- New kinds: `transfer_cancel` (before release) and a permissionless `transfer_release` (or bounded auto-release at block apply).
- New kinds rejected below v7. State root, snapshots and light-client proofs need versioning.
- **Invariant**: `sum(balances) + sum(escrow) == genesis supply - burned fees`. Exactly one of release or refund per entry, enforced by deleting it. Property tests over random transfer/cancel/release sequences, double-release and double-cancel tests, snapshot round-trip, and tests that allocation-locked funds cannot be escrowed out early.
- Estimated 10-15 engineering days.

**Threat model**: if the sending key also holds cancel authority, a thief can cancel too, so it covers mistakes and recipient-side compromise only; split-transfer evasion of the threshold (rolling-window cap); state bloat griefing (per-sender caps, fees); proposer timestamp drift shifting release; receivers and exchanges must treat pending funds as unconfirmed (pending/final API).

**Owner decisions**: **cancel authority** (sender key vs separate key); **threshold defaults**, minimum amount, delay, per-account cap and rolling window; auto-release vs release transaction.

## 5. Feature 3: wallet light-client verification via an imported proof bundle

**What exists**: `website/verify/light-client.js` (browser port of `l1/src/light-client.ts`) verifies headers, commits, v6 certificates and state proofs, with tests. The PWA keeps `connect-src 'none'`.

**Gap is data, not code**: the gateway does not serve State-v2 inclusion/non-membership proofs or validator-set transition proofs, and the PWA's wallet chain `zyron-wallet-testnet-1` runs protocol 1, which has no sparse state root (`protocolUsesStateV2`, `l1/src/chain.ts`).

**Proposal**: `/verify/` fetches and verifies, then exports a proof bundle (anchor, headers, certificates, later state proofs) that the PWA imports by file and re-verifies locally. The CSP is not relaxed. **Headers only now**, labelled "headers verified to anchor H". Balance/nonce proofs need **State-v2 on the wallet chain and gateway proof endpoints**.

**Threat model**: pinned genesis/checkpoint anchor that must be updated on resets; validator-set transition proofs; untrusted bundle input (strict validation, proof size caps); users over-reading "verified".

**Feasibility**: headers-only M (4-6 days); state proofs +M (3-5 days) once served.

**Owner decisions**: **State-v2 timing** for the wallet chain; anchor pin and update process.

## 6. Feature 6B: `intentHash` in signing payload v3

**Proposal**: a new transaction version 3 whose signing payload includes `intentHash = hash(rendered text, renderer version)`; validators recompute and reject mismatches. Signing payloads are v2 today. The renderer becomes consensus-critical: byte-exact, locale-free, integer-only BigInt formatting.

**Threat model**: renderer divergence becomes a consensus fault; versioning of renderer and payload; same homoglyph/bidi rules as 6A.

**Feasibility**: depends on 6A; estimated +6-8 days. New protocol version, activation off, owner review.

**Owner decisions**: whether 6B is needed at all while transactions stay fully structured.

## 7. Feature 2: seedless recovery (last)

Ships only behind **its own spec and external human review**.

**Shape**: today address = hash(pubkey), one permanent key. Recovery needs an `authKey` per account, guardian configuration, and time-locked `recovery_initiate` / `recovery_cancel` / `recovery_execute` transactions. Signature verification changes for every transaction, so this is consensus-critical. Simpler v1 options: off-chain Shamir-split keystore backup (no consensus change), or a single recovery key with a time lock.

**Exclusions**: validator keys and locked genesis allocation addresses cannot configure recovery. Rotation must never reset allocation locks.

**Threat model**: guardian collusion and sybil guardians (mitigated by time lock plus owner veto); offline owner with malicious guardians; approval replay (bind chainId and nonce in every approval); recovery spam (bond, rate limit); mempool must drop transactions signed by a rotated key.

**Feasibility**: estimated 20-30 engineering days without passkeys; +10-15 with P-256 passkeys.

**Owner decisions**: **guardian rules** (count, threshold, bond, delay, veto); passkey support.

## Feature 4: fee v1 (shipped)

Implemented in #1086, **not activated** ([FEE_POLICY_V1.md](../FEE_POLICY_V1.md)): a fixed, predictable fee split between burn and producer. Describe it as **"no fee auction"**, not "no MEV": a block producer can still order transactions in its own block.

## Open owner decisions (summary)

1. **Cancel authority** for reversible transfers (sender key or separate key).
2. **Threshold defaults** for reversible transfers (threshold, delay, minimum, per-account cap, rolling window) and for wallet warnings.
3. **Guardian rules** for seedless recovery.
4. **State-v2 timing** on the wallet chain, which gates balance/nonce proofs in feature 3.
5. Supply verifier trust root (full replay vs signed snapshot, who signs).
6. Whether 6B proceeds, and which further kinds become wallet-signable.
7. Activation of any consensus feature (each stays off until owner review).
