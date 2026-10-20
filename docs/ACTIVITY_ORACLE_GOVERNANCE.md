# Activity-oracle governance: m-of-n settlement approval (P1-01, H3)

Status: consensus rule. **Not activated on any value-bearing network.** Real oracle public keys are not in this repository. Choosing m, n and the key holders remains an owner decision. Supply stays 50,000,000 ZYN. `mining_claim` stays retired. `publicTestnetActivationAllowed` and `mainnetActivationAllowed` stay false.

## Policies

`activityOraclePolicy` versions the authorization rule. Omitting it leaves historical chains unchanged, including their genesis hash.

| Policy | When | Authorization |
|---|---|---|
| absent, no `activityOracleThreshold` | existing dev and test genesis files | one registered oracle signs the settlement |
| absent, with `activityOracleThreshold` | existing private chains that already opted into m-of-n | lenient m-of-n over domain `zyronchain/activity-settlement-approval/v1`. Unregistered approvals are ignored. A duplicate key counts once |
| `test-single-v1` | explicit dev/test profile | one registered oracle. Cannot be combined with `launchProfile: "fixed-supply-v1"` and cannot declare `activityOracleThreshold`. Cap defaults to 10,000 ZYN and can be lowered |
| `threshold-v1` | required by `fixed-supply-v1` | fail-closed m-of-n. Floor is 2-of-3 or stricter |

`threshold-v1` accepts a threshold only when all of the following hold: at least three registered keys, m at least 2, m at most n, at least one spare key (`n - m >= 1`), and at least two-thirds of the keys (`m * 3 >= n * 2`). That accepts 2-of-3, 3-of-4, 4-of-5, 4-of-6 and 5-of-7. It rejects 2-of-2, 2-of-4, 3-of-3 and 3-of-5. Every registered key must be a valid secp256k1 point. The open testnet uses three freshly generated test keys and threshold 2. It does not set `activitySettlementCapAtoms`, so the 1,000 ZYN default applies.

### Fail-closed attestation (`threshold-v1`)

Approvals use domain `zyronchain/activity-settlement-approval/v2`. The signed payload is `{ chainId, sender, epoch, entries, receiptRoot, expiresAtMs }`. The settlement stores `expiresAtMs` as `attestationExpiresAtMs` (omitted on legacy encodings, so those txids stay identical).

A settlement is rejected when any of the following is true:

- the submitter is not a registered, non-revoked oracle, or the oracle schedule is paused;
- `attestationExpiresAtMs` is missing, or it does not lie in the epoch settlement window `[genesis + (e + 1) * 24 h, genesis + (e + 2) * 24 h)` (stale);
- the including block's timestamp is after `attestationExpiresAtMs` (expired);
- an approval repeats the submitter or another approval's public key (duplicate signer);
- an approval's public key is not registered (unknown) or is revoked;
- the same signature bytes appear twice (replay);
- an approval does not verify over the v2 payload, including a v1-domain signature or a wrong chain id;
- fewer than m distinct registered keys signed (the submitter counts as one).

A legacy genesis that carries `attestationExpiresAtMs` is rejected. The epoch-already-settled error stays "Activity epoch already settled".

## Pause, resume and revoke

`activity_oracle_governance` fits the existing validator-quorum model (`validator_update`): quorum `floor(2N/3)+1`, activation at least `MIN_VALIDATOR_UPDATE_DELAY` (100) blocks ahead, and a separate activation cursor that must strictly increase. The signing domain is `zyronchain/activity-oracle-governance-approval/v1`. The transaction signing domain is `zyronchain/transaction/activity-oracle-governance/v1`.

| Action | `publicKeys` | Effect at the activation height |
|---|---|---|
| `pause` | empty | every later settlement is rejected until resume |
| `resume` | empty | settlements are allowed again. Refused unless a pause is already scheduled |
| `revoke` | distinct registered keys that are not already revoked | those keys can no longer submit or approve |

A second pause while one is already scheduled is refused. Revoke may drop the active set below m. Settlements then fail closed until a future consensus change can register a replacement. **Adding a replacement key is not implemented.** There is no CLI wrapper; callers use `createActivityOracleGovernance` and `createActivityOracleGovernanceApproval`.

Chain snapshots stay version 1, byte-identical, until any oracle-governance entry exists. The first such entry makes the snapshot version 2 and adds `activityOracleGovernance`. State v2 stores `activity-oracle-governance:<height>` as `{ action, publicKeys }`. The field is omitted from portable governance objects when the list is empty.

Genesis configuration is committed in the genesis previous-hash slot when `launchProfile`, `activityOracleThreshold`, `activityOraclePolicy` or `activitySettlementCapAtoms` is present. Legacy genesis files that omit all four keep the zero previous hash.

## Problem

The following sections describe the historical single-key problem and the lenient opt-in threshold that a genesis without `activityOraclePolicy` still uses. `threshold-v1` is specified above.

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

The table below is the legacy opt-in threshold (no `activityOraclePolicy`), whose cap is 10,000 ZYN. Under `threshold-v1` the same theft of m keys is capped at 1,000 ZYN per epoch and per rolling 24 h (or the lower configured cap), unknown approvals are rejected rather than ignored, and a repeated signature is a replay.

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

- `fixed-supply-v1` requires the `threshold-v1` floor: at least 2-of-3, one spare key, and at least two-thirds of the registered keys. 3-of-5 is below that floor and is refused.
- `n - m >= 1`, so one unavailable oracle does not halt payouts. 2-of-3 meets the floor.
- Keys must be held by independent people or organisations in separate failure domains (different hosts, ideally hardware-backed signers). m keys on one machine provide no protection.

## Disagreement and withholding

- **Oracles disagree on a payload.** Every distinct payload needs its own m approvals. If no payload reaches m, the epoch is not settled before its window closes, and it is forfeited. Nothing is paid, and nothing accumulates for later. The activity being rewarded can still be paid in a later epoch, within that epoch's own cap. A registered oracle that signs a different payload cannot spoil the agreed one unless it is added to the agreed settlement's approval list. The submitter chooses that list, so a conflicting approval is simply left out.
- **Oracles withhold.** If fewer than m oracles sign, the epoch is forfeited (liveness only, no loss of funds). Operators should alert when an epoch window closes unsettled.
- **Two valid settlements for the same epoch.** Only one can be included. The second fails with "Activity epoch already settled".

## Key rotation and revocation

Pause, resume and revoke are the on-chain response to a compromised key (see above). They do not add a replacement key. Today the remaining options are:

1. **Compromise of fewer than m keys:** revoke the affected keys. Honest oracles can keep settling as long as at least m registered keys remain.
2. **Compromise that could reach m, or a revoke that drops the active set below m:** pause immediately. Settlements stop. Replacing the key set needs a later consensus change or a new genesis. The `threshold-v1` cap (default 1,000 ZYN per epoch and per rolling 24 h) bounds what m colluding keys can move before the pause activates.
3. **New network:** choose fresh keys in a new genesis before any value-bearing launch. Do not copy test keys.

Operational guidance:
- Each oracle signs only payloads it computed itself from the receipt data for the closed epoch. `threshold-v1` uses `createActivityOracleApprovalV2` (the signature covers `expiresAtMs`). The legacy threshold uses `createActivityOracleApproval`. An oracle never signs a payload supplied by another party without recomputing it.
- Keep a signed log of every approval, recording epoch, payload hash and time.
- Store keys offline or in an HSM where possible, and never put two oracle keys on one host.

## Interaction with the genesis launch profile

`launchProfile: "fixed-supply-v1"` requires `activityOraclePolicy: "threshold-v1"` and therefore a 2-of-3-or-stricter threshold. The same profile also requires `allocationLocks`, at least four distinct validators and `publicDistributionRelease`. The genesis hash commits to that policy, the threshold, the oracle keys, the validator set, the locks, the release schedule and any lowered cap. `test-single-v1` cannot be used on that profile. Activation flags stay false: this requirement does not start a value-bearing network.

The sections below describe the earlier opt-in threshold (`activityOracleThreshold` without `activityOraclePolicy`). That encoding is unchanged for genesis files that already use it.

## Tests

`l1/test/activity-oracle-threshold-v1.test.ts`:

- `fixed-supply-v1` refuses a single oracle, `test-single-v1`, 2-of-2, 2-of-4, 3-of-5 and a cap above 1,000 ZYN, and accepts 2-of-3 and 3-of-4.
- `threshold-v1` rejects one key, duplicate signers, unknown keys, repeated signature bytes, a v1-domain signature, a stale expiry, an expired attestation and a wrong chain id.
- A lowered cap is enforced. Total supply stays 50,000,000 ZYN. `mining_claim` stays retired.
- A validator quorum can pause, revoke and resume across the activation delay. Snapshot version 2 restores. State v2 commits the pause under its own semantic key.
- A legacy genesis still settles 10,000 ZYN with one key and rejects `attestationExpiresAtMs`.

## Legacy opt-in threshold

The rest of this document describes `activityOracleThreshold` without `activityOraclePolicy`.

## Tests (legacy threshold)

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
