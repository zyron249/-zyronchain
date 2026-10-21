# Proof of possession for incoming validators (design, P1-07)

Status: **design proposal only. Nothing in this document is implemented.** This is a consensus and cryptography change. It has had a self-review by one AI system only; it is not an audit and needs an independent review. The implementation will follow as separate, failing-first PRs.

Backlog item: P1-07 (F-05 residual).

## Problem

A `validator_update` transaction installs a new validator set at `activationHeight`. Consensus checks today (`transaction.ts` `validateTransactionShape`, `chain.ts` `validateValidatorUpdateAuthorization`):

- every entry of `validators` is a well-formed record whose `address` is derived from its `publicKey`, whose key is a valid secp256k1 point (F-05, `assertValidPublicKey`), with no duplicate address or key (`validateValidator`);
- the sender is an active validator;
- at least `floor(2n/3) + 1` of the **current** validators approve the exact payload `{ chainId, nonce, sender, activationHeight, validators }` under the domain `zyronchain/validator-set-approval/v1`;
- `activationHeight >= height + MIN_VALIDATOR_UPDATE_DELAY` (100) and activation heights strictly increase;
- a fixed-supply launch chain keeps at least 4 and at most 100 validators.

Nothing proves that the holder of each **incoming** public key agreed to join, or that anybody holds the private key at all. Consequences:

1. **Dead slots.** A typo, a copied key from another chain, or a key whose private part was lost can be voted in. Each such slot counts toward `n` but never signs. With `n = 4` and quorum 3, one dead slot leaves no fault tolerance; two halt the chain. Recovery needs another `validator_update`, which itself needs a quorum of the (now partly dead) set.
2. **Unconsented keys.** A quorum can name a key that belongs to an operator who never agreed to validate this chain (for example a published key of another network). That operator is then listed as a validator of this chain without consent, and the dead-slot effect of point 1 applies.
This is not a rogue-key attack in the BLS sense: approvals and votes are individual secp256k1 signatures, there is no key aggregation, so an incoming key cannot cancel or forge other validators' signatures. The impact is liveness and consent, not safety or supply. Severity per the original F-05 residual: Low/Medium (liveness), consensus-scoped.

## Proposal

### Possession proof

Each validator in `tx.validators` that is **not already in the current set with the same address and public key** must carry a proof of possession: a signature by its own private key over

```
domain:  "zyronchain/validator-possession/v1"
payload: { chainId, activationHeight, address, publicKey }
```

signed with the same canonical signing scheme as other governance approvals of the transaction's version (`signForTransactionVersion`). Binding `chainId` and `activationHeight` means a proof cannot be replayed into another chain or into a later update; the key holder consents to one specific activation. `address` and `publicKey` bind the proof to the slot.

Validators already in the current set (same address and key) need no new proof: their consent was proven when they joined (or at genesis).

### Wire format

A new optional top-level field on `validator_update`:

```json
"possessionProofs": [ { "address": "...", "signature": "<64-byte hex>" } ]
```

- exactly one entry per incoming validator, in the order those validators appear in `validators`; no entry for continuing validators; no extra or duplicate entries (`assertExactKeys`, as for all other records);
- the field is covered by the sender's transaction signature and the txid, like every other field;
- it is **not** added to the approval payload: approvers sign the set, key holders sign their own consent; the transaction carries both. (Including it in the approval payload would force a second approval round whenever a proof arrives late, with no security gain, since the proofs are already bound to `chainId`, `activationHeight` and the slot.)

### Activation (no change to existing chains)

Replay of existing data directories must stay byte-for-byte identical. Two options:

- **Option A (recommended): genesis opt-in.** A new genesis field `validatorAdmission: "possession-proof-v1"`, bound by the existing genesis configuration commitment (`docs/GENESIS_CONFIG_BINDING.md`). `launchProfile: "fixed-supply-v1"` then requires it. No value-bearing chain exists yet (activation flags are false), so the launch genesis can carry it from block 0 and the rule holds for the whole life of that chain. Existing devnets and the open test network keep their genesis hash and behaviour. Cost: the launch genesis file and the tokenomics check gain one field; the open test network keeps the old rule until it is re-created.
- **Option B: protocol version.** Require proofs for `validator_update` included at or after a new protocol version (7), scheduled through `protocol_upgrade`. Works for live chains, but adds a protocol version, its schedule rules and v6/v7 interaction tests, and leaves a launch chain without the rule until the upgrade activates.

Option A is smaller, has no live-chain migration, and covers the launch chain from genesis. Option B can be added later if a live chain needs the rule.

### Where it is enforced

The check belongs in `validateValidatorUpdateAuthorization` (it needs the current set) and therefore runs on every path that already calls it: mempool admission, pending selection / block production, block validation (proposal and attested block). The raw state appliers (legacy and State-v2) do not need a change: both chain callers run shape validation and authorization first; this is pinned by tests in the same way as the reserved tracker address (#1080, #1081).

The CLI / tooling that builds a `validator_update` gains a step to collect each incoming operator's proof (the operator signs locally; the private key never leaves the operator's host).

## Test plan (failing-first)

1. Under a genesis with the rule: an update adding a validator **without** a proof is refused at shape/authorization in the mempool, in `produceBlock` / `selectValidPending`, and in `validateProposal` / `acceptBlock` (with a real finality certificate). Must fail on main before the fix.
2. A proof signed by a different key, for a different `chainId`, for a different `activationHeight`, or for a different slot is refused.
3. Extra, duplicate, misordered, or continuing-validator proofs are refused (exact-keys / exact-count).
4. An incoming key that is not a valid secp256k1 point stays refused (already enforced by `validateValidator` since F-05; pinned, not changed).
5. A valid update with correct proofs is accepted and activates at `activationHeight`; a continuing validator needs no proof.
6. Under a genesis **without** the rule: historical behaviour is unchanged (existing validator-update tests unchanged and green; a replay fixture of an existing chain keeps its state roots).
7. `fixed-supply-v1` genesis without the new field is refused; the configuration commitment covers it.
8. Mutation sanity: removing each check makes at least one test fail.

## Out of scope

- Supply, allocations, fees, vesting and locks: unchanged.
- Remote signer custody of the possession proof (the reference signer may add a dedicated intent later; P0-09 / P5-08).
- Removing validators: no proof needed (removal needs no consent of the removed key).

## Merge rule

Consensus/crypto change: full l1 gates (npm ci, typecheck, npm test, open-testnet smoke), green PR CI, and a clean AI code review before merge; an independent retest afterwards before any status moves to VERIFIED FIXED.
