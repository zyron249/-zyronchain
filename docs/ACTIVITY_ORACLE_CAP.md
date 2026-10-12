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

Settled epochs form a strictly increasing sequence. This follows from rule 2 alone: block timestamps strictly increase, so the most recently closed epoch never moves backwards, and every earlier settlement was for an epoch at or below the current one. The `e + 1` check is defence in depth in the state appliers, which have no block timestamp.

Because every epoch settles at most once and only during the following 24 h, the per-settlement cap is also the per-epoch cap. Missed epochs are forfeited rather than carried over, so idle time never builds up headroom that a compromised key could take in one burst. The activity being rewarded is not lost: a later settlement may reward activity from earlier periods, still within its own cap; the epoch number is a rate-limit slot, not a receipt identifier.

## Bounds

The cap is per fixed epoch, not per rolling 24 h window. This is intentional: the rule is "each closed epoch once, in order", which keeps validation stateless with respect to earlier block times.

- A single oracle key can move at most 10,000 ZYN per epoch (0.2% of the 5,000,000 ZYN pool).
- Inside any rolling 24 h window it can move at most 20,000 ZYN: epoch e can be settled at the last millisecond of epoch e + 1 and epoch e + 1 at the first millisecond of epoch e + 2, but epoch e + 2 cannot be settled before the next boundary, 24 h later. More generally, any window of length W pays at most (ceil(W / 24 h) + 1) x 10,000 ZYN.
- The long-run average is at most 10,000 ZYN per day. Paying out the full pool takes at least 500 epochs, so it cannot complete earlier than 500 days after genesis.
- Monitoring and incident response should assume the 20,000 ZYN worst case for any single day. A rolling-window rule would be a consensus and tokenomics change and needs explicit owner approval.

`l1/test/activity-oracle-epoch-bound.test.ts` pins these bounds.
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
