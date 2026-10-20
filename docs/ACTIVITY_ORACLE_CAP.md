# Activity-oracle payout cap (ZC-CRY-20260930-010)

Status: consensus rule on `main`, enforced under every protocol version (v1, v2, v3, v5, v6). It does not change the total supply (50,000,000 ZYN) or the activity pool size (the 5,000,000 ZYN ecosystem/community reserve).

## Problem

Activity settlements are signed by a single key listed in `genesis.activityOracles`. Before this change one such key could:

- settle the whole remaining activity pool in a single `activity_settlement` (the payout was bounded only by the pool balance), and
- settle any unsettled epoch number in any order, including far-future epochs.

The oracle set is fixed in genesis, so a compromised oracle key could not be revoked before it drained the pool.

## Rule

Consensus constants in `l1/src/activity.ts`:

| Constant | Value |
|---|---|
| `ACTIVITY_EPOCH_MS` | 86,400,000 ms (24 h). Epoch `e` covers `[genesis.timestampMs + e * 24 h, genesis.timestampMs + (e + 1) * 24 h)` |
| `MAX_ACTIVITY_SETTLEMENT_ATOMS` | 10,000 ZYN (1,000,000,000,000 atoms) per settlement |

A settlement is valid only if all of the following hold (in addition to the existing oracle-key, pool-sender, outflow-only, nonce and balance checks):

1. **Cap:** the sum of its entries is at most 10,000 ZYN.
2. **Window:** the including block's timestamp lies in epoch `e + 1`, so only the most recently closed epoch can be settled. A current or future epoch is rejected ("not closed yet"); an older epoch is rejected ("settlement window has closed").
3. **Once, in order:** epoch `e` is not already settled, and epoch `e + 1` is not settled.

Settled epochs form a strictly increasing sequence. This follows from rule 2 alone: block timestamps strictly increase, so the most recently closed epoch never moves backwards, and every earlier settlement was for an epoch at or below the current one. The `e + 1` check is defence in depth in the state appliers.

Because every epoch settles at most once and only during the following 24 h, the per-settlement cap is also the per-epoch cap. Missed epochs are forfeited rather than carried over, so idle time never builds up headroom that a compromised key could take in one burst. The activity being rewarded is not lost: a later settlement may reward activity from earlier periods, still within its own cap; the epoch number is a rate-limit slot, not a receipt identifier.

## Versioned cap (`activityOraclePolicy`)

`MAX_ACTIVITY_SETTLEMENT_ATOMS` (10,000 ZYN) remains the absolute ceiling for a genesis that does not opt into `threshold-v1`. Public-launch genesis uses a lower ceiling:

| Policy | Default cap | Maximum cap | Who authorizes |
|---|---|---|---|
| absent (historical) | 10,000 ZYN | 10,000 ZYN (not configurable) | one registered key, or the legacy lenient threshold when `activityOracleThreshold` is set without a policy |
| `test-single-v1` | 10,000 ZYN | 10,000 ZYN, configurable downward with `activitySettlementCapAtoms` | one registered key. Refused together with `launchProfile: "fixed-supply-v1"` |
| `threshold-v1` | 1,000 ZYN (`PUBLIC_LAUNCH_ACTIVITY_CAP_ATOMS`) | 1,000 ZYN, configurable downward to 1 atom | fail-closed m-of-n, at least 2-of-3 (see `ACTIVITY_ORACLE_GOVERNANCE.md`) |

`fixed-supply-v1` requires `threshold-v1`, plus allocation locks, at least four validators and `publicDistributionRelease`, so a public-launch genesis cannot keep the 10,000 ZYN single-key budget. `activitySettlementCapAtoms` is ignored unless a policy is present, and a value above that policy's maximum is refused at genesis.

## Rolling 24 h cap (fixed-supply-v1)

A genesis with `launchProfile: "fixed-supply-v1"` enforces a rolling window at the same configured cap (default 1,000 ZYN under `threshold-v1`):

4. **Rolling window:** the settlements whose block timestamps lie within any 24 h window sum to at most that cap. Concretely, a settlement of amount `a` in a block at time `t` is rejected when the previous settlement (time `t0`, amount `a0`) satisfies `t - t0 < 24 h` and `a0 + a` exceeds the configured cap. Two settlements exactly 24 h apart are in different windows. The rejection text is "Activity settlements exceed the activity cap in a rolling 24-hour window".

Checking only the previous settlement is enough. By rule 2 each 24 h epoch of block time contains at most one settlement, so a window of 24 h or less contains at most two settlements, and they are consecutive.

The previous settlement's block timestamp and amount are consensus state. They are stored as the nonces of two protocol-reserved, zero-balance accounts (`ZYN000…0001` for the timestamp, `ZYN000…0002` for the amount). The accounts hold no balance, so total supply and allocations are unchanged. Both state representations commit them like any other account, so snapshots, checkpoints, state sync and restarts carry the record. Under the profile, transfers, settlement entries and genesis allocations to these addresses are rejected.

The rule is checked in both state appliers (block validation and block production) using the including block's timestamp, and at mempool admission using the earliest possible next block time. A settlement that is too early for the rolling window is rejected, not queued, and must be resubmitted later in its epoch window.

A genesis without a launch profile keeps rules 1-3 only, at the historical 10,000 ZYN ceiling (or a lower `test-single-v1` cap). This is deliberate, so that existing development and test chains do not fork. On those chains two adjacent epochs can be settled either side of an epoch boundary: up to twice the per-epoch cap inside one 24 h window. A public launch uses `fixed-supply-v1`, so the rolling window applies and the ceiling is at most 1,000 ZYN.

## Bounds

- Historical and `test-single-v1` genesis: at most 10,000 ZYN per epoch (0.2% of the 5,000,000 ZYN pool), or less when the test profile sets a lower cap.
- `threshold-v1`, including every `fixed-supply-v1` genesis: at most 1,000 ZYN per epoch and inside any rolling 24 h window (0.02% of the pool), or less when `activitySettlementCapAtoms` is set. Paying out the full pool takes at least 5,000 epochs at the default cap.
- One registered key cannot authorize a `threshold-v1` settlement. Pause and revoke are described in `ACTIVITY_ORACLE_GOVERNANCE.md`.

`l1/test/activity-rolling-24h-cap.test.ts` pins the rolling cap (protocol v1, v3 and v6, both appliers, reserved addresses, restart). `l1/test/activity-oracle-epoch-bound.test.ts` pins the per-epoch behaviour of a genesis without a launch profile.
- Cumulative payouts never exceed the pool's genesis balance (outflow-only pool, unchanged).

Block timestamps must increase and may be at most 120 s ahead of a validator's clock, so a proposer cannot open a future window early in any meaningful way, and an oracle key alone cannot influence block time.

## Where it is enforced

| Path | Cap | Window | Once / order |
|---|---|---|---|
| Transaction shape (`validateTransactionShape`: gossip, RPC, block decoding, mempool) | yes | - | - |
| Chain mempool admission (`validateMempoolAdmission`) | yes | yes (earliest next-block time) | yes |
| Pending selection (`selectValidPending`, given the proposal's exact timestamp) | yes | yes | yes |
| Block production, proposal, prepared-block and finalized-block validation (`validateAndApply`, using the block's own timestamp; legacy and v6) | yes | yes | yes |
| Legacy applier `LedgerState.apply` | yes | - | once + adjacent order |
| State-v2 applier `applyStateV2Transaction` | yes | - | once + adjacent order |

The state appliers have no block context, so the window is enforced on the chain paths, which every block goes through. Nodes drop mempool settlements whose window has closed (`isActivitySettlementExpired`, judged against the earliest possible next-block time) so a stale settlement cannot pin the pool nonce.

## Compatibility

This is a consensus rule with no activation height, like the mining retirement. It is safe before launch: no public ZyronChain L1 network exists, and no fixture, checkpoint or genesis profile in this repository contains an activity settlement. A private chain whose history contains a settlement that violates these rules would no longer replay and must restart from a new genesis.

The oracle must sign epoch `e` and submit it during epoch `e + 1` (after `genesis.timestampMs + (e + 1) * 24 h`).

## Not covered (open)

- **Real oracle keys and custody.** No production public keys are in this repository. `activity-oracle-production-governance` in `PUBLIC_LAUNCH_CHECKLIST.md` stays blocked until independent oracle operators exist. The open testnet generates disposable test keys.
- **Replacing a revoked key.** Pause, resume and revoke exist. Adding a replacement key does not.
- The default 1,000 ZYN public cap, and whether a weaker threshold than two-thirds (for example 3-of-5) should be allowed, are owner decisions. The constants are pre-genesis policy.

Tests: `l1/test/activity-oracle-cap.test.ts` (historical 10,000 ZYN cap, window, ordering, cumulative bound, mempool expiry), `l1/test/activity-oracle-threshold-v1.test.ts` (policy, lower cap, fail-closed attestation), `l1/test/activity-rolling-24h-cap.test.ts`, plus `activity-airdrop-cap.test.ts` and `fixed-supply-genesis-invariants.test.ts`.
