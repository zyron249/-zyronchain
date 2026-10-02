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

## Mining retirement for the fixed-supply launch

The current codebase still contains protocol-v5 mining code for historical/local-rehearsal compatibility. The fixed-supply launch does **not** depend on deleting that code to prevent issuance.

A genesis that allocates the full 50,000,000 ZYN consumes the entire consensus supply ceiling. The existing mining schedule therefore returns a next reward of zero and rejects every mining claim with the maximum historical issuance reached. No later fee burn reopens issuance headroom.

This property is pinned by `l1/test/fixed-supply-tokenomics.test.ts`.

Before any value-bearing launch, the final genesis must be independently checked with:

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
