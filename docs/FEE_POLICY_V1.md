# Fee policy v1

Status: **implemented, not activated**. No shipped genesis sets `feePolicy`. `publicTestnetActivationAllowed` and `mainnetActivationAllowed` stay false. `mining_claim` stays retired. The 50,000,000 ZYN genesis supply is unchanged.

This document specifies a fixed, low, predictable protocol fee. A user can know the fee before signing. The fee is not an auction.

## What stays the same until a genesis opts in

`feePolicy` is an optional genesis field, protocol rule version **fixed-fee-v1**.

Genesis files that omit it — every current devnet, the open testnet, the wallet testnet, and every historical fixture — keep the previous rules:

- a transfer may carry any non-negative integer fee;
- the whole fee is burned (debited from the sender, credited to nobody);
- local block selection may still order transfers by fee;
- a higher fee may still replace the same sender and nonce in the mempool.

Those blocks validate exactly as before. Adding `feePolicy` to a live data directory changes the genesis hash. Do not add it to an existing chain.

## The one parameter

Under `launchProfile: "fixed-supply-v1"`, a genesis may commit to:

```json
"feePolicy": { "version": "fixed-fee-v1", "fixedTransferFeeAtoms": 100000 }
```

`fixedTransferFeeAtoms` is the only tunable value. It must be a positive integer of atoms, at most the 50,000,000 ZYN supply. The proposed launch default is **0.001 ZYN = 100,000 atoms** (`ATOMS_PER_ZYN / 1000` in `l1/src/fee-policy.ts`). A chain that opts in uses the number in its own genesis. Nodes do not substitute a second fee.

`fixed-fee-v1` is refused unless `launchProfile` is `fixed-supply-v1`. Any other version, a zero fee, or an extra field is refused at genesis.

## Consensus rule

When the field is present, every `transfer` must set `feeAtoms` to that constant. Any other fee is rejected:

- at transaction shape validation, when the caller passes the committed fee;
- at mempool admission (`validateMempoolAdmission` and `Mempool.add` on a node that loaded the genesis);
- at block production, proposal validation, and finalized block validation.

Other transaction kinds keep a zero fee. `mining_claim` remains rejected on every path and under every protocol version.

The rule applies on the protocol version the chain is already running (v1, v2, v3, v5, or v6). It does not add a consensus protocol version and it does not schedule an upgrade by itself. Chains that never set `feePolicy` never execute it.

## No fee auction

On a fixed-fee-v1 chain:

- block selection orders transfers by mempool arrival, then by sender nonce (FIFO per sender nonce). It does not rank them by fee. Authorized governance transactions still sit ahead of transfers so a flood of transfers cannot push a validator or protocol transaction out of the block; that order is not a fee rank;
- the same sender and nonce cannot be replaced by another fee. Replacement-by-higher-fee is disabled. A conflicting nonce is rejected;
- when the mempool is full, a new transfer is rejected. The pool does not evict a transfer for a higher fee, because every admitted transfer pays the same fee.

Block validity does not depend on this order. Two proposers that saw different arrivals may pack different valid transactions. The fee on each included transfer is still the committed constant.

## Fee split

For each included transfer:

- the sender is debited `amount + fee`;
- the receiver is credited `amount`;
- the block producer (the block's proposer, the validator for that height and round) is credited `floor(fee / 2)`;
- the remainder, `fee - floor(fee / 2)`, is not credited. It is burned. An odd atom goes to the burn.

Examples: 100,000 atoms → 50,000 burned and 50,000 to the producer. 3 atoms → 2 burned and 1 to the producer. 1 atom → 1 burned and nothing credited.

A zero producer share does not create an account. The producer cannot be the activity pool or the reserved mining-tracker address. Crediting the producer moves atoms that were already debited. It does not mint.

Supply identity, checked after every block in `l1/test/fee-policy-v1.test.ts`:

```text
sum(account balances) + burned fees = genesis supply
sum(account balances) <= genesis supply
```

No path in this policy increases the sum of balances above the genesis supply. Activity settlements only move atoms already in the ecosystem reserve. Mining claims are rejected and mint nothing.

## Spam limits

These bounds already constrain every chain. fixed-fee-v1 does not raise them. They are the admission limits once fees can no longer buy priority.

| Limit | Value | Enforced at |
|---|---:|---|
| Pending transactions per sender | 64 | Mempool nonce window (`stateNonce + 1` … `stateNonce + 64`) and the node mempool count cap `MAX_MEMPOOL_PENDING_PER_SENDER` |
| Mempool transactions (non-mining) | 10,000 | `Mempool` capacity |
| Mempool bytes (non-mining) | 64 MiB | `Mempool` byte capacity |
| Transactions in one block | 10,000 | `MAX_BLOCK_TRANSACTIONS` |
| Block bytes | 2,000,000 | `MAX_BLOCK_BYTES` |
| Transaction bytes in one block | 1,500,000 | `MAX_BLOCK_TRANSACTION_BYTES` |

`l1/test/fee-policy-v1.test.ts` pins each number and rejects a 65th pending nonce, a per-sender count above the cap, a selection limit above 10,000, and a block that cannot fit the next transfer in the byte budget.

## Validator support from the ecosystem reserve

Status: **NOT IMPLEMENTED**. This section is a design note only. It requires an explicit owner decision before any code, genesis field, schedule, or transfer exists. This change does not move atoms out of any allocation.

The fixed-supply genesis already assigns **5,000,000 ZYN** to the ecosystem/community reserve. That reserve is also the activity pool. It cannot be refilled. Nothing in this repository mints a validator reward on top of it.

If the owner later wants validators to receive support from that reserve, the only source under consideration is that existing 5,000,000 ZYN reserve. The founder allocation, the public-distribution allocation, and the permanent-liquidity reserve are not sources. A future design would have to be all of the following, and still would not be authorized by this document:

- **Schedule-based.** A public schedule committed in a future genesis or a future audited protocol upgrade: a start time, a length, and a fixed amount per block or per epoch. The amount is written down in advance. It is not a percentage of volume and not a fee auction.
- **Transparent.** Each payout is an ordinary consensus debit of the reserve, visible in the block, and limited by the reserve's remaining balance.
- **Bounded by the reserve.** Cumulative support plus activity settlements cannot exceed the atoms that genesis put in the reserve. The reserve cannot be topped up.
- **Address-free here.** This document names no account. The reserve address and any recipient addresses would be supplied by the owner at that future decision, the same way other role addresses are supplied outside this repository. No address is invented here.

Until that decision, validator compensation from the reserve does not exist. The only validator credit implemented by fee policy v1 is the producer half of a transfer fee, and only on a genesis that has opted into `fixed-fee-v1`.

## Wallet

The phone wallet (`website/app`) and the Snap fill **0.001 ZYN (100,000 atoms)** when the fee is left empty. The review screen shows the fee and the total before anything is signed. The phone wallet keeps `connect-src 'none'` and signs on the device. The Snap shows the same fee in its confirmation before it signs. A caller may still pass a different fee; the current testnet has not opted into the consensus rule, so this default does not by itself change that network.

## Activation

`docs/fixed-supply-launch-plan.json` records the proposed parameter and sets `consensusEnforcementActivated` and `activationGates.fixedFeePolicyV1Activated` to false. Do not set `feePolicy` on a published genesis until the owner reviews this rule.
