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

Consensus enforces only that a genesis allocates at most 50,000,000 ZYN (and, with mining retired, nothing can be issued later). The rules "exactly 50,000,000 ZYN, split 5,000,000 / 20,000,000 / 20,000,000 / 5,000,000 across four distinct role addresses, and the activity pool is the ecosystem/community reserve" are enforced by the offline verifier `assertFixedSupplyGenesis`. Therefore the mainnet genesis ceremony **MUST** run `npm run tokenomics:check` against the final genesis file and the four role addresses, and the genesis **MUST NOT** be published, signed, or used to start any validator unless the command exits 0. The ceremony record must include the exact command, its output, the SHA-256 digest of the genesis file and the release commit it was built from. The same requirement is listed in [`PUBLIC_LAUNCH_CHECKLIST.md`](PUBLIC_LAUNCH_CHECKLIST.md) section 4.

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

Residual risk: any single genesis activity oracle key can still settle the entire remaining pool balance in one batch; oracle custody, per-epoch caps, and multi-oracle thresholds are open review items (internal crypto review finding ZC-CRY-20260930-010, documented on branch `audit/crypto-review-20260930`).

## Founder allocation

The founder allocation is **5,000,000 ZYN (10%)**.

The intended custody rule is:

- 12-month cliff;
- then 36 months of linear vesting;
- no unilateral early-unlock path.

The amount and schedule are recorded here, but **the current L1 does not yet enforce founder vesting at consensus level**. The 5M founder allocation must not be treated as safely locked until a reviewed protocol-controlled vesting mechanism or equivalent audited custody construction exists and has regression tests.

## Permanent liquidity

The target economic model is a non-custodial buy/sell surface where user quote assets enter the liquidity pool rather than a founder wallet, and sells return quote assets from the same pool.

The intended liquidity property is stronger than a temporary time lock: no founder/admin withdrawal path should exist after launch.

That AMM is **not implemented by this change**. ZyronChain currently has a native ZYN ledger but no audited native representation of USDC (or another quote asset) and no production bridge/custody mechanism. A website must not pretend to offer live ZYN/USDC trading until those components exist.

The liquidity reserve therefore remains a disclosed genesis role, not a live pool.

## Public distribution

The 20,000,000 ZYN public-distribution allocation is a reserve for the eventual public distribution mechanism. It is not permission for a maintainer, website, or backend to custody purchaser funds.

Before enabling a public purchase surface, the project must freeze and review at least:

- the quote asset and how it exists on ZyronChain;
- AMM invariant and fee rules;
- initial pool ratio / starting price;
- slippage and minimum-output protections;
- permanent LP ownership/burn mechanism;
- front-running/MEV assumptions;
- bridge or custody trust model, if any;
- founder vesting enforcement;
- applicable legal/compliance requirements for a public token distribution.

## Activation discipline

This design does not flip `publicTestnetActivationAllowed`, `mainnetActivationAllowed`, miner-publication flags, or website trading controls.

The next engineering step is to implement and audit the missing on-chain vesting and two-asset liquidity primitive before any real-money buy/sell interface is enabled.
