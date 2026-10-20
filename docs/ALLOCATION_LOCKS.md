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

Without the field, behaviour is unchanged for a genesis that is not a value-bearing class (older genesis files and test networks keep working). A `networkClass` of `public-launch`, `value-bearing` or `mainnet` is refused at node start unless `launchProfile` is `fixed-supply-v1`, and that profile refuses the genesis unless this field is present. See [`GENESIS_NETWORK_CLASS.md`](GENESIS_NETWORK_CLASS.md). When the field is present it is validated fail-closed when the chain is constructed:

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
| Trusted snapshot restore (`fromTrustedSnapshot`) | yes | yes | yes |
| Trusted snapshot install and reopen of the installed node, plus a violating block appended after the checkpoint | n/a (requires State v2) | yes | yes |
| Recovery-checkpoint reopen (v1: unpruned checkpoint; v5: pruned history, no full-replay fallback) with a violating block appended | yes | yes | yes |
| P2P checkpoint transfer, then install | n/a (requires State v2) | yes | yes |
| Portable State-v2 install, and P2P portable state sync then install | n/a | yes | yes |
| State-v2 store rebuild on reopen (corrupted root metadata) | n/a | yes | yes |

The v6 rows were `test.todo` until v6 trusted-snapshot tips became verifiable with the commit certificate (#963); they now run the same assertions as v5.

- `l1/test/p0-07-vesting-clock-light-client.test.ts` (P0-07 follow-ups, v1/v5/v6): the vesting clock and light-client behaviour described in the two sections below. A vested founder spend stamped more than 120 s ahead of the verifier clock is refused by `acceptBlock`, `validateFinalizedBlock` and a durable store (also after restart); exactly 120 s ahead is accepted; a spend stamped at the cliff is refused even with the verifier clock 120 s behind; mempool admission ignores the transaction timestamp; the light client accepts a quorum-signed header that a full node refuses.

### Vesting clock

Vesting is evaluated at the block's own timestamp. Every verifier refuses a block stamped more than 120 s after its local clock (`Block time too far in future`, `block.ts`), and block timestamps must strictly increase. A proposer can therefore move a founder unlock forward by at most 120 s relative to honest verifiers' clocks, and only for amounts that are vested at the stamped time. Mempool admission and `spendableBalance()` use the earliest next-block time derived from the node clock (`max(now, tip + 1 ms)`), never the transaction's own `timestampMs`. A node whose clock runs fast accepts correspondingly earlier; operators should keep node clocks synchronised (for example with NTP).

### Light clients

The light client (`l1/src/light-client.ts`) verifies a finalized header against an independently trusted anchor: chain ID, height and previous-hash continuity, proposer signature and the legacy round/attestation quorum or the v6 commit certificate of the anchored validator set, plus State-v2 inclusion proofs against the header's state root. It does not execute transactions and has no local clock, so it does not enforce allocation locks or the 120 s future bound itself. If the trusted validator quorum finalizes a block that spends locked funds (for example because it runs a lock-free twin genesis), the light client follows that header and reports the resulting balances. This is the usual light-client trust model: the guarantee is "a quorum of the trusted validator set signed this", not "this block is valid". Mitigations are honest, independent validators running the published genesis, the pinned genesis digest, and `launchProfile: "fixed-supply-v1"` (the genesis hash then commits to `allocationLocks`, so an anchor taken from the published genesis cannot belong to a lock-free twin chain, although the quorum can still sign an invalid block). Applications that need execution guarantees should run a full node.

Trust assumption: a trusted snapshot or portable state is authoritative for the state it pins. If an operator pins the anchor of a tip finalized on a twin chain that already moved locked funds, the install accepts that state, because the pre-tip state is not available to re-check. Honest validators running the published genesis never finalize such a block, so this requires a broken validator supermajority plus a wrong anchor; the ceremony pins the genesis digest, and `launchProfile` genesis binding (#961) makes a twin genesis a different chain.

## Ecosystem / activity-pool reserve (fixed-supply-v1)

Under `launchProfile: "fixed-supply-v1"` the activity pool (the 5M ZYN
ecosystem/community allocation) can only be debited by authorized activity
settlements (m-of-n oracle approval, per-epoch cap and the rolling
10,000 ZYN / 24 h window). Any other debit signed by the pool key, such as a
plain transfer or a fee-only transfer, is refused by consensus: in mempool admission,
block production and validation, and both state appliers used for replay.
Holding the pool key therefore gives no withdrawal path. Genesis files without
the launch profile keep the historical behaviour. Regression test:
`l1/test/activity-pool-direct-debit.test.ts`.
