# ZyronChain fixed-supply tokenomics

Status: **draft implementation for review; activation remains blocked**.

This document records the current fixed-supply design decision for the intended value-bearing ZyronChain launch. It does not activate a public sale, mainnet, bridge, AMM, liquidity pool, or custody arrangement.

## Frozen supply

Total historical supply is fixed at **50,000,000 ZYN** (5,000,000,000,000,000 atoms).

The intended genesis allocation is:

| Role | ZYN | Share |
|---|---:|---:|
| Founder allocation | 5,000,000 | 10% |
| Public distribution | 20,000,000 | 40% |
| Permanent-liquidity reserve | 20,000,000 | 40% |
| Ecosystem/community reserve | 5,000,000 | 10% |
| **Total** | **50,000,000** | **100%** |

`l1/src/tokenomics.ts` encodes these amounts and fails closed if the four disclosed role addresses are duplicated, malformed, reserved, missing, or assigned the wrong amount.

## Mining retirement (all genesis configurations)

Owner decision (2026-09-30, confirmed 2026-10-11): mining is shut down for **every** genesis, not only the fixed-supply one.

Consensus now rejects `mining_claim` transactions explicitly and fail-closed on every path: transaction shape validation (so gossip and block decoding refuse them), mempool admission, `Mempool.add`, block production and pending selection, block/proposal validation, and both the legacy `LedgerState` and State-v2 appliers. The rejection does not depend on protocol version or on the genesis supply. `miningRewardAtoms` always returns 0; the historical 6.25 ZYN / 4,000,000-claim schedule is kept only as `historicalMiningRewardAtoms` for reference and never authorizes issuance.

Independently, a genesis that allocates the full 50,000,000 ZYN would also exhaust the historical schedule, and no fee burn reopens headroom.

The rejection also covers protocol v6 (the locked two-phase consensus): v6 blocks are decoded and validated through the same transaction shape check and state appliers, so a v6 proposal, prepared block or commit that carries a `mining_claim` is refused before any state transition. `l1/test/fixed-supply-genesis-invariants.test.ts` exercises protocols v1, v2, v3, v5 and v6 on every path, proves that a genuine proof of work after v5 or v6 activation mints nothing, and proves that a fully allocated genesis holds exactly 50,000,000 ZYN and never grows.

### Historical chain replay

The rejection is unconditional rather than gated by an activation height. This is safe because no shipped chain data contains a finalized mining claim: mining could only run after an on-chain protocol-v5 upgrade, no public network ever activated it, and no fixture, checkpoint or genesis profile in this repository contains a `mining_claim`. A private chain that did finalize a mining claim would no longer replay and must be restarted from a new genesis.

The packaged miner (`npm run mine`) and the local rehearsal (`npm run mine:local`) are disabled and exit non-zero. These properties are pinned by `l1/test/mining*.test.ts`, `l1/test/local-mining-path.test.ts` and `l1/test/fixed-supply-tokenomics.test.ts`.

Compatibility note: this is a consensus rule change. Any existing chain data that contains a finalized mining claim (for example a local protocol-v5 rehearsal chain) will no longer validate or replay; such chains must be discarded.

## Mainnet genesis ceremony: mandatory supply check

For a legacy genesis that omits `networkClass`, consensus enforces only that it allocates at most 50,000,000 ZYN (and, with mining retired, nothing can be issued later). A genesis that declares `launchProfile: "fixed-supply-v1"` makes the rules "exactly 50,000,000 ZYN, split 5,000,000 / 20,000,000 / 20,000,000 / 5,000,000 across four distinct role addresses, the activity pool is the ecosystem/community reserve, and `allocationLocks` names exactly the founder and permanent-liquidity allocations" consensus rules, and its genesis hash commits to the entire configuration (see [`GENESIS_CONFIG_BINDING.md`](GENESIS_CONFIG_BINDING.md)). A `networkClass` of `public-launch`, `value-bearing` or `mainnet` is refused unless that profile is set, so a value-bearing chain cannot skip the locks by omitting the profile or by choosing another one (see [`GENESIS_NETWORK_CLASS.md`](GENESIS_NETWORK_CLASS.md)). The offline verifier `assertFixedSupplyGenesis` additionally checks the four role addresses chosen by the owner, and `tokenomics:check` refuses a launch genesis without the profile and without a value-bearing network class. Therefore the mainnet genesis ceremony **MUST** run `npm run tokenomics:check` against the final genesis file and the four role addresses, and the genesis **MUST NOT** be published, signed, or used to start any validator unless the command exits 0. The one signature collected before that final run is the validator possession proof (P1-07, [`VALIDATOR_POSSESSION_PROOF.md`](VALIDATOR_POSSESSION_PROOF.md)), because the final check verifies it: first run `tokenomics:check ... --before-possession-proofs` on the file with `validatorAdmission: { "policy": "possession-proof-v1", "genesisProofs": [] }` (every other rule is checked and the command prints the configuration commitment the validators sign), then each validator operator signs locally, then run the command again **without** the flag on the file with every proof. Only that last run counts as the final check. The ceremony record must include the exact command, its output (including the printed configuration commitment and genesis hash), the SHA-256 digest of the genesis file and the release commit it was built from. The same requirement is listed in [`PUBLIC_LAUNCH_CHECKLIST.md`](PUBLIC_LAUNCH_CHECKLIST.md) section 4.

Run it from the `l1/` directory:

```sh
cd l1
npm run tokenomics:check -- \
  --genesis /path/to/genesis.json \
  --founder ZYN... \
  --public-distribution ZYN... \
  --liquidity-reserve ZYN... \
  --ecosystem-reserve ZYN...
```

No private keys belong in the repository.

## Activity airdrop (ecosystem/community pool only)

Owner decision (2026-09-30, confirmed 2026-10-11): the Proof-of-Activity airdrop is paid **only** from the 5,000,000 ZYN ecosystem/community reserve.

`assertFixedSupplyGenesis` (and therefore `npm run tokenomics:check`) fails closed unless the genesis `activityPool` is exactly the ecosystem/community reserve address; the founder, public-distribution and permanent-liquidity addresses are rejected explicitly.

Consensus treats the activity pool as outflow-only: transfers and activity-settlement entries that credit the activity pool are rejected at mempool admission, block validation and state application (legacy and State-v2 appliers). Because the pool starts with exactly 5,000,000 ZYN and can never be refilled, cumulative activity airdrops can never exceed 5,000,000 ZYN. This is pinned by `l1/test/activity-airdrop-cap.test.ts` and `l1/test/fixed-supply-tokenomics.test.ts`.

Oracle limits (ZC-CRY-20260930-010, H3): a genesis without an activity-oracle policy still caps every settlement at 10,000 ZYN, allows only the most recently closed 24 h epoch, and requires epochs to settle once and in increasing order. `launchProfile: "fixed-supply-v1"` requires `activityOraclePolicy: "threshold-v1"` (at least 2-of-3 fail-closed attestation) and caps settlements at 1,000 ZYN per epoch and inside any rolling 24 h window, configurable only downward. One registered key cannot authorize a payout on that profile. See [`ACTIVITY_ORACLE_CAP.md`](ACTIVITY_ORACLE_CAP.md) and [`ACTIVITY_ORACLE_GOVERNANCE.md`](ACTIVITY_ORACLE_GOVERNANCE.md). Choosing m, n and the real oracle key holders, and production custody, remain open. This does not change the 50,000,000 ZYN supply or the allocations.

## Founder allocation

The founder allocation is **5,000,000 ZYN (10%)**.

The intended custody rule is:

- 12-month cliff;
- then 36 months of linear vesting;
- no unilateral early-unlock path.

Consensus enforces this schedule when the genesis declares `allocationLocks.founderVesting` (required by `npm run tokenomics:check`): measured from the genesis timestamp at the including block's timestamp, nothing is spendable during the 365-day cliff, then the allocation is released linearly over 1,095 days; a transfer (amount plus fee) may never leave the founder account below the still-locked amount. There is no early-unlock path. See [`ALLOCATION_LOCKS.md`](ALLOCATION_LOCKS.md). The `founderVestingConsensusEnforced` flag in `fixed-supply-launch-plan.json` stays `false` until the mechanism is independently audited and the owner signs off.

## Permanent liquidity

The target economic model is a non-custodial buy/sell surface where user quote assets enter the liquidity pool rather than a founder wallet, and sells return quote assets from the same pool.

The intended liquidity property is stronger than a temporary time lock: no founder/admin withdrawal path should exist after launch.

That AMM is **not implemented by this change**. ZyronChain currently has a native ZYN ledger but no audited native representation of USDC (or another quote asset) and no production bridge/custody mechanism. A website must not pretend to offer live ZYN/USDC trading until those components exist.

The liquidity reserve therefore remains a disclosed genesis role, not a live pool. Consensus locks it completely when the genesis declares `allocationLocks.permanentLiquidity` (required by `npm run tokenomics:check`): every outflow, including fees, is rejected forever, and inflows stay locked. Releasing any of it would need a future audited mechanism, a protocol upgrade and owner approval. See [`ALLOCATION_LOCKS.md`](ALLOCATION_LOCKS.md).

## Public distribution

The 20,000,000 ZYN public-distribution allocation is a reserve for the eventual public distribution mechanism. It is not permission for a maintainer, website, or backend to custody purchaser funds.

On a public-launch, value-bearing or mainnet genesis the allocation cannot be spent in full on day one. The genesis must declare `publicDistributionRelease` (version public-distribution-release-v1): an owner-supplied address plus an explicit cliff and linear length. The owner decided the default: no cliff (`cliffMs` 0) and a 365-day linear release (`linearMs` 31,536,000,000). The linear floor is 365 days, so day one releases only the accrued slice. See [`PUBLIC_DISTRIBUTION_RELEASE.md`](PUBLIC_DISTRIBUTION_RELEASE.md). `launchProfile: "fixed-supply-v1"` requires the field, including on the open testnet. Genesis files that omit both the profile and a value-bearing class keep the previous rule.

Before enabling a public purchase surface, the project must freeze and review at least:

- the quote asset and how it exists on ZyronChain;
- AMM invariant and fee rules;
- initial pool ratio / starting price;
- slippage and minimum-output protections;
- permanent LP ownership/burn mechanism;
- front-running/MEV assumptions;
- bridge or custody trust model, if any;
- independent audit of the founder vesting and liquidity lock enforcement ([`ALLOCATION_LOCKS.md`](ALLOCATION_LOCKS.md));
- applicable legal/compliance requirements for a public token distribution.

## Fee policy v1 (implemented, not activated)

The proposed transfer fee is a single launch-profile parameter: **0.001 ZYN (100,000 atoms)**. See [`FEE_POLICY_V1.md`](FEE_POLICY_V1.md).

A genesis opts in by setting `feePolicy` to `{ "version": "fixed-fee-v1", "fixedTransferFeeAtoms": 100000 }` together with `launchProfile: "fixed-supply-v1"`. The integer is the only tunable value. Consensus then rejects every transfer whose fee is not that integer, at shape validation, mempool admission, and block validation. `floor(fee / 2)` is credited to the block producer. The rest is burned, and an odd atom goes to the burn. `sum(balances) + burned` stays equal to the genesis supply. Nothing mints. Block selection does not rank by fee, and a higher fee cannot replace a pending transaction.

No shipped genesis sets the field. Current testnet and historical blocks keep a full burn and whatever fee they already carry. `docs/fixed-supply-launch-plan.json` leaves `fixedFeePolicyV1Activated` false.

### Validator support from the ecosystem reserve (NOT IMPLEMENTED)

This is a design note for the owner. It is not a transfer, a schedule, or a genesis field. It requires an explicit owner decision before any of those exist. No address is named here.

The 5,000,000 ZYN ecosystem/community reserve is the only source under consideration for optional validator operating support. The founder allocation, the public-distribution allocation, and the permanent-liquidity reserve are not sources. If the owner later approves it, the support would be a public schedule (start, length, and a fixed amount per block or per epoch) debited from that reserve, visible in the block, and capped by the reserve's remaining balance. The reserve cannot be refilled. This change does not implement that debit.

## Activation discipline

This design does not flip `publicTestnetActivationAllowed`, `mainnetActivationAllowed`, miner-publication flags, or website trading controls.

On-chain founder vesting and the permanent-liquidity lock are implemented ([`ALLOCATION_LOCKS.md`](ALLOCATION_LOCKS.md)) and await independent audit. The next engineering step is the two-asset liquidity primitive, which must also be audited before any real-money buy/sell interface is enabled.
