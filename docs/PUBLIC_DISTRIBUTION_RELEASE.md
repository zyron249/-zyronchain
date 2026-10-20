# Public-distribution release (public-distribution-release-v1)

Status: consensus rule for a value-bearing genesis. It does not activate mainnet, it does not invent a role address, and it does not change the fixed 50,000,000 ZYN supply. `mining_claim` stays retired. Zyron Points are not ZYN.

## Problem

Under `launchProfile: "fixed-supply-v1"` the 20,000,000 ZYN public-distribution allocation is an ordinary account. Whoever holds that key can move all of it in the first block. The address is chosen outside this repository.

## Version

`publicDistributionRelease` is an optional genesis field, version **public-distribution-release-v1**.

```json
"publicDistributionRelease": {
  "address": "ZYN...",
  "cliffMs": 0,
  "linearMs": 31536000000
}
```

`address` is an input. This repository does not contain a real role address. `cliffMs` and `linearMs` must be written in the genesis file. Nodes do not fill them in silently.

Genesis files that omit the field keep the previous rule: that allocation is spendable, and a file that also omits `launchProfile`, `activityOracleThreshold`, `activityOraclePolicy`, `activitySettlementCapAtoms` and `networkClass` keeps the historical genesis hash. Adding the field commits the full configuration (see [`GENESIS_CONFIG_BINDING.md`](GENESIS_CONFIG_BINDING.md)). Do not add it to a live devnet or testnet data directory.

`launchProfile: "fixed-supply-v1"` and a `networkClass` of `public-launch`, `value-bearing` or `mainnet` are refused at node start unless the field is present and inside the bounds below. A genesis that omits both the profile and a value-bearing class may omit the field. The wallet testnet, the local devnet and the private testnet omit it, so they keep a spendable allocation. The open testnet uses `fixed-supply-v1`, so it declares the schedule (no cliff, 365-day linear release) on its public-distribution faucet. The faucet drips from the vested slice; the full 20,000,000 test ZYN is not spendable on day one.

## Schedule

The rule reuses `linearCliffVestedAtoms` (the same helper as founder vesting). Time is the including block's timestamp minus `genesis.timestampMs`.

- Nothing is vested at or before `cliffMs` (including exactly at the cliff).
- After that, vested atoms = `floor(genesisAllocation * min(elapsed - cliff, linear) / linear)`.
- A debit (amount plus fee) is rejected when it would leave the account below the still-locked part of its **genesis allocation**.
- Inflows are spendable immediately. The lock does not swallow coins that arrived later.
- The total supply does not change. A fee, if any, is still burned.

## Parameters (decided by owner)

Consensus enforces the explicit values in the genesis file, inside the fail-closed floors. The linear floor is what keeps the full allocation from unlocking on day one.

| Parameter | Owner decision | Fail-closed bound | Status |
|---|---|---|---|
| `cliffMs` | `0` (no cliff) | `0` to 100 years | decided by owner |
| `linearMs` | 365 days (`31,536,000,000`) | 365 days to 100 years | decided by owner |
| `address` | none in this repository | the public-distribution allocation; under `fixed-supply-v1`, the 20,000,000 ZYN account that is not the founder, the permanent-liquidity reserve, or the activity pool | owner input |

Nothing is vested at elapsed `0`. One millisecond later the first linear slice vests: `floor(allocation / linearMs)`. At exactly 24 hours the vested amount is one day of the line, `floor(allocation * 86,400,000 / linearMs)`. With the decided 365-day line that is `floor(allocation / 365)`, not the full 20,000,000 ZYN. A linear length below 365 days is rejected, so no allowed schedule can make the whole allocation spendable on day one. The full allocation is spendable only after `cliffMs + linearMs`. A longer cliff is still allowed; nothing vests at or before that cliff.

`npm run tokenomics:check` prints the configured `cliffMs` and `linearMs` and the line `decided by owner`.

## What stays unchanged

- Founder vesting and the permanent-liquidity lock are unchanged.
- A genesis that omits this field, and that also omits `fixed-supply-v1` and a value-bearing class, does not suddenly lock an existing testnet allocation.
- No activation flag is flipped.
