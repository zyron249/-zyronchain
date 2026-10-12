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

## Rolling 24 h cap (fixed-supply-v1)

Owner rule: at most 10,000 ZYN of activity settlements per 24 hours. A genesis with `launchProfile: "fixed-supply-v1"` enforces it as a consensus rule from genesis:

4. **Rolling window:** the settlements whose block timestamps lie within any 24 h window sum to at most 10,000 ZYN. Concretely, a settlement of amount `a` in a block at time `t` is rejected when the previous settlement (time `t0`, amount `a0`) satisfies `t - t0 < 24 h` and `a0 + a > 10,000 ZYN`. Two settlements exactly 24 h apart are in different windows.

Checking only the previous settlement is enough. By rule 2 each 24 h epoch of block time contains at most one settlement, so a window of 24 h or less contains at most two settlements, and they are consecutive.

The previous settlement's block timestamp and amount are consensus state. They are stored as the nonces of two protocol-reserved, zero-balance accounts (`ZYN000…0001` for the timestamp, `ZYN000…0002` for the amount). The accounts hold no balance, so total supply and allocations are unchanged. Both state representations commit them like any other account, so snapshots, checkpoints, state sync and restarts carry the record. Under the profile, transfers, settlement entries and genesis allocations to these addresses are rejected.

The rule is checked in both state appliers (block validation and block production) using the including block's timestamp, and at mempool admission using the earliest possible next block time. A settlement that is too early for the rolling window is rejected, not queued, and must be resubmitted later in its epoch window.

A genesis without a launch profile keeps rules 1-3 only. This is deliberate, so that existing development and test chains do not fork. On those chains two adjacent epochs can be settled either side of an epoch boundary: up to 20,000 ZYN inside one 24 h window, while the long-run average is still at most 10,000 ZYN per day. A public launch uses `fixed-supply-v1`, so this does not apply to it.

## Bounds

- A single oracle key (or, with `activityOracleThreshold`, a threshold of oracle keys) can move at most 10,000 ZYN per epoch (0.2% of the 5,000,000 ZYN pool).
- Under `fixed-supply-v1`: at most 10,000 ZYN inside any 24 h window.
- The long-run average is at most 10,000 ZYN per day. Paying out the full pool takes at least 500 epochs, so it cannot complete earlier than 500 days after genesis.

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

- **m-of-n oracle approval.** Implemented as an opt-in genesis parameter (`activityOracleThreshold`), see `ACTIVITY_ORACLE_GOVERNANCE.md`. A genesis without it keeps single-oracle settlements; the cap above applies in both cases.
- **Oracle custody and governance** (`activity-oracle-production-governance` in `PUBLIC_LAUNCH_CHECKLIST.md`) stay blocked until independent oracles exist.
- The constants are pre-genesis policy. Changing them later is a consensus change.

Tests: `l1/test/activity-oracle-cap.test.ts` (every path and protocol version, window, ordering, cumulative bound, mempool expiry), plus the updated `activity-airdrop-cap.test.ts` and `fixed-supply-genesis-invariants.test.ts`.
