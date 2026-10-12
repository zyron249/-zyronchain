# On-chain allocation locks (founder vesting and permanent liquidity)

Status: consensus rule on `main`, enforced under every protocol version (v1, v2, v3, v5, v6) whenever the genesis declares `allocationLocks`. It does not change the total supply (50,000,000 ZYN), any allocation amount, the activity-pool cap or any activation flag in [`fixed-supply-launch-plan.json`](fixed-supply-launch-plan.json); those flags stay `false` until an independent audit and owner sign-off.

## Problem

The fixed-supply plan ([`FIXED_SUPPLY_TOKENOMICS.md`](FIXED_SUPPLY_TOKENOMICS.md)) gives the founder 5,000,000 ZYN with a 12-month cliff and 36 months of linear vesting, and keeps a 20,000,000 ZYN permanent-liquidity reserve. Before this change both were ordinary accounts: either key could move the whole allocation in the first block after genesis.

## Genesis declaration

A genesis may carry an optional field:

```json
"allocationLocks": {
  "founderVesting": "ZYN...",
  "permanentLiquidity": "ZYN..."
}
```

Without the field, behaviour is unchanged (older genesis files and test networks keep working). When present it is validated fail-closed when the chain is constructed:

- exactly the two keys `founderVesting` and `permanentLiquidity`;
- both are valid, distinct ZYN addresses;
- neither is the reserved mining tracker nor the activity pool;
- both addresses must have a genesis allocation.

For the fixed-supply launch, `assertFixedSupplyGenesis` (and therefore `npm run tokenomics:check`) additionally requires `allocationLocks` to name exactly the founder allocation (`founderVesting`) and the permanent-liquidity allocation (`permanentLiquidity`). The verifier also runs full consensus genesis validation (`new ZyronChain(genesis)`).

## Rules

All arithmetic is BigInt; there is no floating point.

### Founder vesting

- The schedule starts at `genesis.timestampMs` and is measured at the **including block's timestamp**.
- Cliff: 365 days (31,536,000,000 ms). Nothing is vested before or at exactly the cliff.
- Linear release: the following 1,095 days. Vested amount = `floor(allocation * min(elapsed - cliff, 1,095 days) / 1,095 days)`, saturating at the full allocation.
- The vesting total is the founder account's genesis allocation (5,000,000 ZYN under the fixed-supply plan).
- A debit (transfer amount **plus fee**) is rejected when it would leave the founder account with less than the still-locked amount (`allocation - vested`).
- Inflows to the founder account are allowed and are spendable at once; only the still-locked part of the genesis allocation must stay in place.

The timestamp schedule and the block-height reference schedule in `l1/src/founder-vesting.ts` (30-second target, 1,051,200-block cliff, 3,153,600-block linear release) share one helper, `linearCliffVestedAtoms`, and agree exactly when blocks arrive at the 30-second target.

Why timestamps rather than heights: honest validators refuse blocks more than 120 seconds ahead of their clocks, and block time must strictly increase, so a stalled or unusually fast chain cannot move the unlock date by more than that bound. A height schedule would unlock early if blocks were produced faster than the target, or late after outages.

### Permanent liquidity

- Every outflow from the `permanentLiquidity` account is rejected forever: transfers of any amount, fee-only spends, and activity settlements.
- Inflows are allowed and become locked as well: the lock follows the address, not the coins.
- There is no unlock path in this release. Unlocking would need a future, independently audited mechanism (for example a protocol-controlled AMM), a protocol upgrade and explicit owner approval.

## Where it is enforced

Every debit path receives the lock context:

| Path | Enforcement |
|---|---|
| `LedgerState.apply` (transfer, activity settlement) | optional lock-context parameter; chain paths always pass it |
| `applyStateV2Transaction` (transfer, activity settlement) | same |
| `ZyronChain.validateAndApply` | lock context at the block's own timestamp; used by block production and preparation, proposal, prepared and finalized validation and `acceptBlock`, for v1 and State-v2 (v2/v3/v5/v6) |
| `ZyronChain.selectValidPending` | lock context at the candidate block timestamp; locked spends are omitted |
| `ZyronChain.validateMempoolAdmission` (transfer, activity settlement) | lock context at the earliest next-block timestamp |
| `NodeService.submitTransaction` (RPC and P2P) | the sender's aggregate pending transfer spend must fit `spendableBalance()` |

`ZyronChain.spendableBalance(address)` reports the unlocked balance; `balance()` is unchanged. Mining claims cannot debit (mining is retired), and validator updates and protocol upgrades carry no fee or amount.

## Launch ceremony: pin the genesis file digest

For a legacy genesis (no `launchProfile`) the genesis block hash commits to the chain ID, the genesis timestamp and the initial state root, but **not** to configuration fields such as `validators`, `activityOracles`, `activityPool` or `allocationLocks`. A launch genesis should declare `launchProfile: "fixed-supply-v1"`: its genesis hash then commits to the entire configuration, and consensus refuses it unless `allocationLocks` is present and the 50M 10/40/40/10 split holds (see [`GENESIS_CONFIG_BINDING.md`](GENESIS_CONFIG_BINDING.md)). The launch ceremony must still publish and pin the SHA-256 digest of the exact genesis file and its genesis hash, every operator must verify them before starting a node, and `npm run tokenomics:check` (which requires the profile) must pass on that file (see [`FIXED_SUPPLY_TOKENOMICS.md`](FIXED_SUPPLY_TOKENOMICS.md) and [`PUBLIC_LAUNCH_CHECKLIST.md`](PUBLIC_LAUNCH_CHECKLIST.md)).

## Tests

- `l1/test/allocation-locks.test.ts`: every chain path under v1/v2/v3/v5/v6, including proposer-signed and finalized blocks that smuggle a locked spend; founder spends at height 1 and exactly at the cliff; exact vested amount accepted at mid-linear and one more atom (fee counted) rejected; 1 ms and 1 day linear boundaries; the full balance after the schedule ends; the liquidity reserve refusing every outflow including after 100 years while accepting inflows; node mempool rejection of single and aggregate spends; locks after a store reopen.
- `l1/test/allocation-locks-appliers.test.ts`: raw appliers, arithmetic agreement with the block-height schedule, flooring, saturation and bad input, lock helpers, nine malformed `allocationLocks` variants and the fixed-supply launch check.
- `l1/test/allocation-lock-bypass-paths.test.ts` (P0-07): the locks hold on every path that builds node state other than live block-by-block validation. The attack artifacts are blocks finalized under a lock-free "twin" genesis that has the same chain ID and genesis hash (founder spend before the cliff, liquidity spend, a founder spend stamped one day after the cliff, and a post-cliff overspend by one atom). After each path the node must refuse them in mempool admission, `acceptBlock` and `commitFinalizedBlock`, and the founder and liquidity balances must be unchanged.

| Path | v1 | v5 | v6 |
|---|---|---|---|
| Live chain (baseline, plus twin-genesis control that accepts the founder block) | yes | yes | yes |
| Full finalized-log replay, including a violating block appended to `blocks.ndjson` | yes | yes | yes |
| P2P block sync from a twin-genesis peer (the follower applies the honest prefix and refuses the violating block) | yes | yes | yes |
| Trusted snapshot restore (`fromTrustedSnapshot`) | yes | yes | todo, #963 |
| Trusted snapshot install and reopen of the installed node, plus a violating block appended after the checkpoint | n/a (requires State v2) | yes | todo, #963 |
| Recovery-checkpoint reopen (v1: unpruned checkpoint; v5: pruned history, no full-replay fallback) with a violating block appended | yes | yes | todo, #963 |
| P2P checkpoint transfer, then install | n/a (requires State v2) | yes | todo, #963 |
| Portable State-v2 install, and P2P portable state sync then install | n/a | yes | todo, #963 |
| State-v2 store rebuild on reopen (corrupted root metadata) | n/a | yes | covered by replay |

Trust assumption: a trusted snapshot or portable state is authoritative for the state it pins. If an operator pins the anchor of a tip finalized on a twin chain that already moved locked funds, the install accepts that state, because the pre-tip state is not available to re-check. Honest validators running the published genesis never finalize such a block, so this requires a broken validator supermajority plus a wrong anchor; the ceremony pins the genesis digest, and `launchProfile` genesis binding (#961) makes a twin genesis a different chain.
