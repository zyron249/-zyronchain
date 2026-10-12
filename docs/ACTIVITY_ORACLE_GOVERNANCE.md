# Activity-oracle governance: m-of-n settlement approval (P1-01)

Status: consensus rule, implemented and opt-in per genesis (`activityOracleThreshold`). **Not activated on any network.** Choosing m, n and the key holders is an owner decision. This change does not touch supply, the activity pool size, allocations, the 10,000 ZYN per closed 24 h epoch cap, the settlement window or ordering (see `ACTIVITY_ORACLE_CAP.md`).

## Problem

Activity settlements pay out from the 5,000,000 ZYN ecosystem reserve (the activity pool). Until now any single key listed in `genesis.activityOracles` could authorize a settlement on its own. The cap limits a compromised key to 10,000 ZYN per epoch, but one stolen or misbehaving key could still take the full daily budget every day, and the key set is fixed in genesis.

## Rule

A genesis may declare:

```json
"activityOracles": ["<pubkey 1>", "<pubkey 2>", "<pubkey 3>"],
"activityOracleThreshold": 2
```

`activityOracleThreshold` = m must be an integer with `1 <= m <= n` (n = number of registered oracle keys) and `m <= 100`.

Under such a genesis, an `activity_settlement` is valid only if at least **m distinct registered oracle keys** have signed the same canonical settlement payload:

```
payload = { chainId, sender, epoch, entries, receiptRoot }
approval signature = secp256k1 signature over canonicalJson({ domain: "zyronchain/activity-settlement-approval/v1", payload })
```

- The settlement carries the approvals in a new optional field `oracleApprovals: [{ publicKey, signature }, ...]` (1 to 100 entries). The submitter's transaction signature covers the field, and so does the txid.
- The submitting key must be registered (unchanged rule). It counts as one approval, because its transaction signature covers every payload field. It may also appear in `oracleApprovals`. Either way it is counted once.
- Every `oracleApprovals` entry from a registered key must verify over the payload, repeats included. A single bad signature from a registered key rejects the settlement. This covers a different amount, receiver, epoch, receipt root, chain or pool, and a signature made without the domain.
- Entries from unregistered keys are ignored. They are not verified and not counted.
- The same key is counted at most once.
- With m = 1 the legacy encoding (no `oracleApprovals`) is valid, exactly as before.

The nonce, timestamp and submitter are deliberately not part of the payload. Oracles can therefore sign independently and any of them can submit. An approval cannot fund a second payout, because each epoch settles at most once and only during the following epoch.

### Backward compatibility

- A genesis without `activityOracleThreshold` keeps the old behaviour: the single submitting oracle authorizes, and a settlement carrying `oracleApprovals` is rejected. This means existing chains accept exactly the transaction set they accepted before.
- Legacy settlements keep their exact encoding and txid: `createActivitySettlement` omits the key unless approvals are given. Genesis hashes of existing genesis files are unchanged. Both are pinned by tests.
- Nodes built before this change refuse a genesis that declares `activityOracleThreshold` (unknown genesis key), so old and new nodes cannot silently disagree on such a chain.
- A genesis that declares `activityOracleThreshold` is bound into chain identity. Its genesis header carries the genesis-configuration commitment `SHA-256(canonicalJson({ domain: "zyronchain/genesis-config/v1", genesis }))` in the previous-hash slot instead of zeros (the same commitment the genesis-config-binding change uses for `launchProfile`). Two nodes that differ only in the threshold, or in any other genesis field, therefore have different genesis hashes and cannot peer, sync snapshots or checkpoints, or extend each other's blocks. Genesis files without a threshold keep the zero previous hash and their historical genesis hash. (Codex review finding P1 on PR #969.)
- Under a threshold genesis every `activityOracles` entry must be a valid secp256k1 point (`assertValidPublicKey`, as for validator keys since F-05). An unusable key can therefore never count toward n and make m unreachable. Genesis files without a threshold keep the historical 64-byte-hex check so existing chains still open. (Codex review finding P2 on PR #969.)

### Where it is enforced

The same function (`assertActivitySettlementAuthorized`, `l1/src/activity-oracle.ts`) runs on every path:

| Path | Enforced |
|---|---|
| Transaction shape (`validateTransactionShape`): field shape and bounds only | yes |
| Mempool admission (`validateMempoolAdmission`) | yes |
| Pending selection (`selectValidPending`) | yes (invalid entries skipped) |
| Block production, proposal, prepared and finalized block validation (`validateAndApply`), v1, v2, v3, v5 and v6 | yes |
| Legacy applier `LedgerState.apply` and State-v2 applier `applyStateV2Transaction` | yes, when given the oracle context (chain paths always pass the genesis) |

## Threat model

| Threat | Without threshold | With m-of-n |
|---|---|---|
| One oracle key stolen | Up to 10,000 ZYN per epoch to the attacker | Nothing. The attacker needs m-1 more keys |
| Fewer than m keys stolen or colluding | n/a | Nothing |
| m keys stolen or colluding | n/a | Up to 10,000 ZYN per epoch (the cap still bounds the damage; the full pool takes at least 500 epochs) |
| Approval replay into another epoch, chain or pool | n/a | Rejected: those fields are signed |
| Approval replay within the same epoch (new nonce or timestamp) | n/a | The epoch settles once, so there is no second payout |
| Garbage or oversized approval lists | n/a | At most 100 entries; unregistered entries are skipped without verification |
| Validator censorship of settlements | Possible | Unchanged (liveness only; missed epochs are forfeited, never accumulated) |
| Oracle withholding | One oracle can stop settlements only by not signing if n = 1 | Settlements stop only if more than n - m oracles withhold |

Out of scope: validators collectively rewriting history, and wrong reward *amounts* that m oracles agree on. The receipt root lets them be audited off-chain, but the chain does not verify individual receipts.

### Choosing m and n

- `m >= 2` for any value-bearing network. A launch profile should require this (see "Interaction with the genesis launch profile").
- `n - m >= 1`, so one unavailable oracle does not halt payouts. A reasonable starting point is 2-of-3 or 3-of-5.
- Keys must be held by independent people or organisations in separate failure domains (different hosts, ideally hardware-backed signers). m keys on one machine provide no protection.

## Disagreement and withholding

- **Oracles disagree on a payload.** Every distinct payload needs its own m approvals. If no payload reaches m, the epoch is not settled before its window closes, and it is forfeited. Nothing is paid, and nothing accumulates for later. The activity being rewarded can still be paid in a later epoch, within that epoch's own cap. A registered oracle that signs a different payload cannot spoil the agreed one unless it is added to the agreed settlement's approval list. The submitter chooses that list, so a conflicting approval is simply left out.
- **Oracles withhold.** If fewer than m oracles sign, the epoch is forfeited (liveness only, no loss of funds). Operators should alert when an epoch window closes unsettled.
- **Two valid settlements for the same epoch.** Only one can be included. The second fails with "Activity epoch already settled".

## Key rotation and revocation

The oracle set and threshold are genesis parameters, and there is no on-chain rotation transaction. Today the options are:

1. **Planned rotation or replacement:** a protocol upgrade that introduces an oracle-set update (for example a governance transaction approved by the validator quorum, like `validator_update`, with an activation height). This is future work and needs owner approval.
2. **Emergency (key compromise below m):** no funds are at risk while fewer than m keys are compromised. Remaining honest oracles keep settling, and the compromised key stays registered until a rotation mechanism exists. If compromised keys could reach m, stop signing and treat it as an incident. The cap bounds the loss to 10,000 ZYN per epoch until a rotation or upgrade is deployed.
3. **New network:** choose fresh keys in a new genesis before launch.

Operational guidance:
- Each oracle signs only payloads it computed itself from the receipt data for the closed epoch, using `createActivityOracleApproval`. It never signs a payload supplied by another party without recomputing it.
- Keep a signed log of every approval, recording epoch, payload hash and time.
- Store keys offline or in an HSM where possible, and never put two oracle keys on one host.

## Interaction with the genesis launch profile

The open genesis-config-binding change (#961, `launchProfile: "fixed-supply-v1"`) commits the full genesis object into the genesis hash with the same commitment this change uses. After both merge, the genesis header should carry the commitment when either `launchProfile` or `activityOracleThreshold` is present; the two definitions are identical, so a fixed-supply genesis with a threshold gets one commitment either way. That profile should then also require `activityOracleThreshold >= 2`. This is deliberately not part of this change, to keep it independent of the profile. Merging both will need a small conflict resolution in `validateGenesis` (optional genesis keys), `createGenesisBlock` and `types.ts`; whichever merges second needs a rebase.

## Tests

`l1/test/activity-oracle-threshold.test.ts`, protocol v1, v2, v3, v5 and v6, every path listed above:
- With m=2, a settlement signed only by its submitter is rejected, and adding one more registered approval makes it valid.
- A duplicate signer is counted once.
- Approvals from unregistered keys are ignored, and an unregistered submitter is refused.
- An approval over a different amount, epoch, receiver, receipt root, chain or pool, or one without the domain, is rejected.
- The cap, window and once-only rules are unchanged.
- m=1 keeps single-oracle behaviour, and a legacy genesis rejects `oracleApprovals`.
- Genesis threshold bounds, approval shape bounds, the pinned legacy genesis hash and settlement txids, and helper encoding equivalence.

`l1/test/activity-oracle-threshold-identity.test.ts`:
- Thresholds 1, 2 and 3 over the same oracles and allocations give four distinct genesis hashes (with the legacy genesis), and the genesis header carries the full-configuration commitment.
- A block finalized on a threshold-1 genesis is refused by a threshold-2 node.
- A threshold genesis refuses activity-oracle keys that are not secp256k1 points; a legacy genesis still accepts them (compatibility).
