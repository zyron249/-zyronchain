# Genesis network class (network-class-v1)

Status: consensus gate for value-bearing genesis files. It does not activate a public testnet or a mainnet, it does not invent role addresses, and it does not change the fixed 50,000,000 ZYN supply. `mining_claim` stays retired.

## Problem

Founder vesting (5,000,000 ZYN, 365-day cliff, then 1,095-day linear release) and the permanent-liquidity lock (20,000,000 ZYN, no outflow) are consensus rules only when a genesis declares `launchProfile: "fixed-supply-v1"`. A file that omits the profile, or that tries to name some other profile, does not get those rules. The only accepted launch profile was already `fixed-supply-v1`. The hole was omitting it.

## Version

`networkClass` is an optional genesis field, version **network-class-v1**.

Genesis files that omit the field keep the previous validation and the previous genesis hash (a zero previous-hash on the genesis header, unless they already opted into `launchProfile` or `activityOracleThreshold`). Adding the field to a live genesis changes the genesis hash: the full configuration is committed with the same mechanism as `launchProfile` (see [`GENESIS_CONFIG_BINDING.md`](GENESIS_CONFIG_BINDING.md)). Do not add it to an existing devnet or testnet data directory.

## Closed set

Explicit test classes. Locks stay optional. One validator remains allowed.

- `devnet`
- `local-devnet`
- `testnet`
- `private-testnet`
- `open-testnet`
- `wallet-testnet`

Value-bearing classes. Node start (`new ZyronChain`, which `ChainStore.open` runs) refuses the genesis unless `launchProfile` is `fixed-supply-v1`. That profile refuses the genesis unless `allocationLocks` names the founder and permanent-liquidity allocations and the supply is exactly 50,000,000 ZYN split 5M / 20M / 20M / 5M. The same classes also refuse a validator set of fewer than four distinct public keys, at genesis and on a later validator-set update or checkpoint schedule. One to three validators can finalize with no tolerance for a faulty or offline validator. Test classes stay on the historical range of 1 to 100.

- `public-launch`
- `value-bearing`
- `mainnet`

Any other value, including a missing string, a different profile name, or an extra genesis field, is rejected. There is no profile that means "value-bearing, but the 5M and 20M allocations are spendable".

A chain ID that names `mainnet`, `public-launch` or `value-bearing` as a hyphen-delimited segment (for example `zyron-mainnet-1`) must declare one of the three value-bearing classes. A test class on that chain ID is rejected. Chain IDs that do not name those segments are unchanged. In particular these keep working without `networkClass`:

- local devnet `zyron-local-<hex>`
- `zyron-wallet-testnet-1`
- open testnet `zyron-open-testnet-1` (it already uses `fixed-supply-v1` and the locks)
- private testnet `zyron-render-private-testnet-1`

## Compatibility trade-off

A genesis that omits `networkClass` and whose chain ID does not name a value-bearing class still starts with optional locks. That is deliberate: existing chains and test fixtures must keep their identity and their rules. A value-bearing launch has to set the class. `npm run tokenomics:check` refuses a ceremony file that does not. The residual gap is a chain that is operated as if it had value, but whose chain ID does not name `mainnet`, `public-launch` or `value-bearing`, and whose genesis omits `networkClass`. The ceremony command will not accept that file. Node start will, so that current testnets do not stop.

## What stays unchanged

- Total supply remains 50,000,000 ZYN. Nothing in this version mints.
- `mining_claim` is still rejected on every path.
- No role address is written down here. The four addresses are inputs to `tokenomics:check`.
- `publicTestnetActivationAllowed` and `mainnetActivationAllowed` stay false.
- Zyron Points are not ZYN.
