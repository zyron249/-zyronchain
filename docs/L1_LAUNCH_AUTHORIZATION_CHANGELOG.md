# Launch authorization decision record

On 2026-08-10 the repository owner explicitly authorized both ZyronChain public testnet and mainnet as network classes.

The authorization is recorded by `docs/l1-launch-authorization.json` and is intentionally separated from activation readiness. Authorization grants permission to prepare and operate those network classes; activation remains blocked until the corresponding evidence gates are independently closed.

This record does not freeze a mainnet genesis, allocation, economics, oracle governance, validator-admission policy or production custody provider.
