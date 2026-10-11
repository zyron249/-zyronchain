# Permanent-liquidity AMM and founder-vesting engineering spec

Status: **implementation-gated**. No real-money trading is activated by this document.

## Founder vesting arithmetic

The founder allocation remains 5,000,000 ZYN. The deterministic reference schedule is block-height based to avoid timezone, locale and wall-clock ambiguity:

- target cadence: 30 seconds;
- cliff: 1,051,200 blocks (365 target days);
- linear release: 3,153,600 blocks (1,095 target days);
- no early-unlock path.

`l1/src/founder-vesting.ts` uses integer/BigInt arithmetic and regression tests pin boundary, monotonicity and cap behavior.

Consensus now enforces the equivalent schedule measured in block timestamps from the genesis timestamp (365-day cliff, 1,095-day linear release) when the genesis declares `allocationLocks`; both forms share `linearCliffVestedAtoms` and agree exactly at the 30-second target. Timestamps are used for enforcement because honest validators bound them to their clocks, so block-rate changes cannot move the unlock date. The permanent-liquidity reserve is locked against every outflow. See [`ALLOCATION_LOCKS.md`](ALLOCATION_LOCKS.md).

**Important:** `founderVestingConsensusEnforced` and the other activation gates in `docs/fixed-supply-launch-plan.json` intentionally stay `false` until the enforcement is independently audited and the owner signs off. Enabling a live founder allocation before then is prohibited.

## Permanent-liquidity AMM reference

The intended pool uses a constant-product invariant and has no LP token and no administrative remove-liquidity operation. That is the simplest way to express "nobody, including the founder, can withdraw the pool as liquidity."

Reference swap math lives in `l1/src/amm-math.ts`:

- exact integer BigInt reserve math;
- default 30 bps swap fee;
- hard fee ceiling of 10%;
- output must be positive and below the output reserve;
- post-swap `k` may never decrease;
- explicit minimum-output/slippage calculation.

The AMM math is intentionally isolated from consensus until the quote-asset model is frozen and audited.

## Why the website is still hard-disabled

ZyronChain currently has one native monetary asset. A real ZYN/USDC pool requires a reviewed answer to how USDC exists on ZyronChain. Inventing a fake "USDC" balance or a founder-controlled bridge would violate the non-custodial goal.

Before the website Buy/Sell control can become live, all machine-readable activation gates in `fixed-supply-launch-plan.json` must be true.

The preferred production sequence is:

1. consensus-enforce founder vesting (implemented, awaiting independent audit: [`ALLOCATION_LOCKS.md`](ALLOCATION_LOCKS.md));
2. freeze the quote-asset/bridge trust model;
3. implement pool state and swap transaction types;
4. prove reserve/supply/slippage invariants under replay and restart;
5. independently audit and retest;
6. only then enable the website trading surface.

No step may silently turn a test balance, off-chain point, or custodial database entry into a claimed stablecoin.
