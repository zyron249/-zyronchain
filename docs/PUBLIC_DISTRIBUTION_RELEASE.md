# Public-distribution release (public-distribution-release-v1)

Status: consensus rule for a value-bearing genesis. It does not activate mainnet, it does not invent a role address, and it does not change the fixed 50,000,000 ZYN supply. `mining_claim` stays retired. Zyron Points are not ZYN.

## Problem

Under `launchProfile: "fixed-supply-v1"` the 20,000,000 ZYN public-distribution allocation is an ordinary account. Whoever holds that key can move all of it in the first block. The address is chosen outside this repository.

## Version

`publicDistributionRelease` is an optional genesis field, version **public-distribution-release-v1**.

```json
"publicDistributionRelease": {
  "address": "ZYN...",
  "cliffMs": 7776000000,
  "linearMs": 94608000000
}
```

`address` is an input. This repository does not contain a real role address. `cliffMs` and `linearMs` must be written in the genesis file. Nodes do not fill them in silently.

Genesis files that omit the field keep the previous rule: that allocation is spendable, and a file that also omits `launchProfile`, `activityOracleThreshold` and `networkClass` keeps the historical genesis hash. Adding the field commits the full configuration (see [`GENESIS_CONFIG_BINDING.md`](GENESIS_CONFIG_BINDING.md)). Do not add it to a live devnet or testnet data directory.

A `networkClass` of `public-launch`, `value-bearing` or `mainnet` is refused at node start unless the field is present and inside the bounds below. An explicit test class, and a genesis that omits the class, may omit it. The open testnet, the wallet testnet, the local devnet and the private testnet omit it, so they keep working.

## Schedule

The rule reuses `linearCliffVestedAtoms` (the same helper as founder vesting). Time is the including block's timestamp minus `genesis.timestampMs`.

- Nothing is vested at or before `cliffMs` (including exactly at the cliff).
- After that, vested atoms = `floor(genesisAllocation * min(elapsed - cliff, linear) / linear)`.
- A debit (amount plus fee) is rejected when it would leave the account below the still-locked part of its **genesis allocation**.
- Inflows are spendable immediately. The lock does not swallow coins that arrived later.
- The total supply does not change. A fee, if any, is still burned.

## Parameters (PENDING REVIEW)

These numbers are a product decision. Consensus enforces whatever explicit values are in the genesis, inside the fail-closed floors. The floors exist so a file cannot make the allocation spendable on day one or finish the release the moment the cliff ends.

| Parameter | Documented conservative default | Fail-closed bound | Status |
|---|---|---|---|
| `cliffMs` | 90 days (`7,776,000,000`) | `86,400,000` (1 day) to 100 years | PENDING REVIEW |
| `linearMs` | 1,095 days (`94,608,000,000`) | 365 days to 100 years | PENDING REVIEW |
| `address` | none in this repository | the public-distribution allocation; under `fixed-supply-v1`, the 20,000,000 ZYN account that is not the founder, the permanent-liquidity reserve, or the activity pool | owner input |

With the default cliff, the first 90 days release nothing, so day one releases nothing. With the minimum cliff of one day, elapsed of exactly 24 hours is still inside the cliff, so day one still releases nothing. The first positive release is one millisecond after the cliff.

`npm run tokenomics:check` prints the configured `cliffMs` and `linearMs` and the line `PENDING REVIEW`.

## What stays unchanged

- Founder vesting and the permanent-liquidity lock are unchanged.
- A genesis that omits this field does not suddenly lock an existing testnet allocation.
- No activation flag is flipped.
