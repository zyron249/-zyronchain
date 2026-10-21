# Proof of possession for incoming validators (design, P1-07)

Status: **partly implemented.** The genesis part (`validatorAdmission`, genesis proofs, chain identity, the requirement for value-bearing classes and the `tokenomics:check --before-possession-proofs` ceremony precheck) is implemented in `l1/src/validator-admission.ts`, and so is the `validator_update` part (`possessionProofs`, per-block working schedule). CLI support for collecting proofs for a `validator_update` is a follow-up. This is a consensus and cryptography change. It has had AI review only; it is not an audit and needs an independent review.

Backlog item: P1-07 (F-05 residual).

## Problem

A `validator_update` transaction installs a new validator set at `activationHeight`. Consensus checks today (`transaction.ts` `validateTransactionShape`, `chain.ts` `validateValidatorUpdateAuthorization`):

- every entry of `validators` is a well-formed record whose `address` is derived from its `publicKey`, whose key is a valid secp256k1 point (F-05, `assertValidPublicKey`), with no duplicate address or key (`validateValidator`);
- the sender is an active validator;
- at least `floor(2n/3) + 1` of the **current** validators approve the payload `{ chainId, nonce, sender, activationHeight, validators }` (`signForTransactionVersion`: for transaction version 2 the payload is wrapped as `{ transactionVersion: 2, payload }` and signed under the domain `zyronchain/validator-set-approval/v1`; for version 1 it is signed with plain canonical signing and **no domain**);
- `activationHeight >= height + MIN_VALIDATOR_UPDATE_DELAY` (100) and activation heights strictly increase;
- a fixed-supply launch chain keeps at least 4 and at most 100 validators.

Nothing proves that the holder of each **incoming** public key agreed to join, or that anybody holds the private key at all. Consequences:

1. **Dead slots.** A typo, a copied key from another chain, or a key whose private part was lost can be voted in. Each such slot counts toward `n` but never signs. With `n = 4` and quorum 3, one dead slot leaves no fault tolerance; two halt the chain. Recovery needs another `validator_update`, which itself needs a quorum of the (now partly dead) set.
2. **Unconsented keys.** A quorum can name a key that belongs to an operator who never agreed to validate this chain (for example a published key of another network). That operator is then listed as a validator of this chain without consent, and the dead-slot effect of point 1 applies.
This is not a rogue-key attack in the BLS sense: approvals and votes are individual secp256k1 signatures, there is no key aggregation, so an incoming key cannot cancel or forge other validators' signatures. The impact is liveness and consent, not safety or supply. Severity per the original F-05 residual: Low/Medium (liveness), consensus-scoped.

## Proposal

### Possession proof

A possession proof is a signature by a validator's own private key over

```
domain:  "zyronchain/validator-possession/v1"
payload: { chainId, chainBinding, activationHeight, address, publicKey }
```

`chainBinding` identifies the exact chain, not only its `chainId` (different genesis configurations may share a `chainId` and differ only in genesis hash):

- for a `validator_update` proof it is the chain's **genesis hash**;
- for a genesis proof (next sections) it is the genesis **configuration commitment**, which is proof-independent by construction: `genesisConfigCommitment` is computed over the genesis with `validatorAdmission.genesisProofs` replaced by an empty array, and that same value is what goes into the genesis previous-hash slot. The chain identity therefore never depends on the proof bytes: a different but valid signature by one validator cannot produce a same-`chainId` twin with a different genesis hash that reuses the other validators' proofs, and there is no circularity of signing a hash that covers the proofs themselves.

It is always made with the domain-separated primitive (`signCanonicalDomain` / `verifyCanonicalDomain`), **independent of the transaction version**. (`signForTransactionVersion` signs version-1 payloads with plain `signCanonical` and no domain, which would not give the cross-context separation this proof needs.) Binding `chainId`, `chainBinding` and `activationHeight` means a proof cannot be replayed into another chain (including a same-`chainId` twin with a different genesis) or into a later update; the key holder consents to one specific activation. `address` and `publicKey` bind the proof to the slot.

### Which validators need a proof

Each validator in `tx.validators` that is **incoming relative to the set it replaces** needs a proof. The set it replaces is the latest validator set scheduled with an activation height below `tx.activationHeight` (the active set if no update is pending), not simply the set active at inclusion. Example: an update removes `V` at height 200 and, before that activates, a second update re-adds `V` at height 300; `V` is incoming at 300 and needs a fresh proof. Quorum authorization is unchanged and still uses the set active at inclusion.

Several updates can be included in one block. Block validation (`validateAndApply`) and pending selection (`selectValidPending`) today advance only a scalar last-activation cursor inside a block. The implementation must keep a **per-block working schedule**: each accepted update in the block is added to it before the next update is classified, so a remove-then-re-add of `V` inside one block also needs a proof for `V`.

A validator that continues from the set it replaces needs no new proof, because it already proved possession when it joined: by an earlier proof, or by a genesis proof (next section).

### Genesis validators

Genesis lists only address and public key, which proves nothing about possession. Under the opt-in (see Activation) the genesis therefore also carries one proof per initial validator, over the same domain with `activationHeight: 0`, the genesis `chainId` and the proof-independent genesis commitment as `chainBinding`. Node start refuses an opted-in genesis with a missing, extra, misordered or invalid genesis proof. The proofs are part of the genesis file but, as described above, excluded from the configuration commitment (and so from the genesis hash); every node verifies them at start. This turns "continuing validators were proven" into an invariant for the whole life of an opted-in chain, instead of a trusted grandfathered exception.

### Wire format

A new top-level field on `validator_update`:

```json
"possessionProofs": [ { "address": "...", "signature": "<64-byte hex>" } ]
```

- exactly one entry per incoming validator, in the order those validators appear in `validators`; no entry for continuing validators; no extra or duplicate entries (`assertExactKeys`, as for all other records);
- the field is covered by the sender's transaction signature and the txid, like every other field;
- it is **not** added to the approval payload: approvers sign the set, key holders sign their own consent; the transaction carries both. The proofs are already bound to `chainId`, `chainBinding`, `activationHeight` and the slot;
- **on a chain without the opt-in the field is refused**, exactly as today's exact-key shape refuses it. Accepting it there would let upgraded and older binaries disagree on the same transaction and split a mixed-version network. On an opted-in chain the field is mandatory (an empty array when there is no incoming validator).

### Activation (no change to existing chains)

Replay of existing data directories must stay byte for byte identical.

- **Option A (recommended): genesis opt-in.** A new genesis field, for example

  ```json
  "validatorAdmission": { "policy": "possession-proof-v1", "genesisProofs": [ ... ] }
  ```

  0. **Fail-closed record.** `validatorAdmission` must be a plain record with exactly the keys `policy` and `genesisProofs`; `policy` must be the string `possession-proof-v1`. A missing, non-string or unknown policy, or any extra key, refuses the genesis (a typo or a future policy must never silently get v1 semantics).
  1. **Chain identity.** `validatorAdmission` is added to the `bindConfig` predicate of `createGenesisBlock`, so it alone (without `launchProfile` or any other opt-in field) writes the configuration commitment into the genesis previous-hash slot. Two genesis files that differ only in this rule then have different genesis hashes and P2P identities.
  2. **Where it is required.** It is required for the **value-bearing network classes** (`public-launch`, `value-bearing`, `mainnet`, `docs/GENESIS_NETWORK_CLASS.md`), not for `launchProfile: "fixed-supply-v1"` as such. The existing open test network uses `fixed-supply-v1` with a test class and a persisted genesis that predates the field; it keeps its genesis hash and behaviour and is not refused at startup. Test networks may opt in voluntarily (a new genesis).
  3. No value-bearing chain exists yet (activation flags are false), so a launch genesis carries the rule from block 0. The tokenomics / launch check gains one field.

- **Option B: protocol version (out of scope).** Adding the rule to a live chain through a protocol upgrade is not proposed. Review of earlier drafts showed it needs its own design: a two-stage protocol boundary for freezing updates (a freeze that starts when the version is merely scheduled changes pre-boundary validation), migration proofs for every validator active at the boundary (not only genesis validators), a binding for legacy genesis files whose hash does not commit to the validator and oracle sets, and a new version that inherits every v6 consensus and signing invariant (several consumers compare the version exactly with 6). No value-bearing chain exists yet, so Option A covers the launch chain from block 0 without any of this.

### Where it is enforced

The update check belongs in `validateValidatorUpdateAuthorization` (it needs the scheduled sets and the genesis option) and therefore runs on every path that already calls it: mempool admission, pending selection / block production, block validation (proposal and attested block). The genesis-proof check belongs in `validateGenesis`. The raw state appliers (legacy and State-v2) need no change: both chain callers run shape validation and authorization first; this is pinned by tests in the same way as the reserved tracker address (#1080, #1081).

The CLI / tooling that builds a `validator_update` or a launch genesis gains a step to collect each incoming operator's proof (the operator signs locally; the private key never leaves the operator's host). Launch ceremony order: `npm run tokenomics:check -- ... --before-possession-proofs` on the genesis with `validatorAdmission.genesisProofs: []` checks every other rule and prints the configuration commitment to sign; each validator operator signs it locally; the command is then run again without the flag on the file with every proof, and only that run is the final check.

## Test plan (failing-first)

1. Opted-in chain: an update adding a validator **without** a proof is refused in the mempool, in `produceBlock` / `selectValidPending`, and in `validateProposal` / `acceptBlock` (with a real finality certificate). Must fail on main before the fix.
2. A proof signed by a different key, for a different `chainId`, for a same-`chainId` chain with a different genesis hash, for a different `activationHeight`, for a different slot, or without the domain (plain `signCanonical`) is refused.
3. Extra, duplicate, misordered or continuing-validator proofs are refused; a missing field is refused on an opted-in chain.
4. Pending-schedule case: remove `V` at H1, then re-add `V` at H2 > H1 before H1 activates; the re-add needs a proof for `V`. Same case with both updates in **one block** (block validation and pending selection).
5. A valid update with correct proofs is accepted and activates at `activationHeight`; a continuing validator needs no proof.
6. Opted-in genesis: missing, extra, misordered or invalid genesis proofs are refused at node start; `validatorAdmission` with a missing, non-string or unknown `policy`, or an extra key, is refused.
7. Chain identity: a genesis whose **only** opt-in field is `validatorAdmission` gets a non-zero previous hash and a different genesis hash than the same file without it; replacing one genesis proof by another valid signature does not change the genesis hash.
8. Value-bearing network class without `validatorAdmission` is refused; the existing open-testnet genesis (`fixed-supply-v1`, test class, no field) still opens with the same genesis hash.
9. Chain without the opt-in: a `validator_update` carrying `possessionProofs` is refused; historical behaviour is otherwise unchanged (existing validator-update tests unchanged and green; replay fixtures keep their state roots).
10. An incoming key that is not a valid secp256k1 point stays refused (already enforced by `validateValidator` since F-05; pinned, not changed).
11. Mutation sanity: removing each check makes at least one test fail.

## Out of scope

- Supply, allocations, fees, vesting and locks: unchanged.
- Remote signer custody of the possession proof (the reference signer may add a dedicated intent later; P0-09 / P5-08).
- Removing validators: no proof needed (removal needs no consent of the removed key).

## Merge rule

Consensus/crypto change: full l1 gates (npm ci, typecheck, npm test, open-testnet smoke), green PR CI, and a clean AI code review before merge; an independent retest afterwards before any status moves to VERIFIED FIXED.
