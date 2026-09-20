# Launch authorization decision record

On 2026-08-10 the repository owner explicitly authorized both ZyronChain public testnet and mainnet as network classes.

The authorization is recorded by `docs/l1-launch-authorization.json` and is intentionally separated from activation readiness. Authorization grants permission to prepare and operate those network classes; activation remains blocked until the corresponding evidence gates are independently closed.

This record does not freeze a mainnet genesis, allocation, economics, oracle governance, validator-admission policy or production custody provider.

On 2026-09-20 the machine-readable requirement lists were aligned with [`STANDALONE_L1_READINESS.md`](STANDALONE_L1_READINESS.md) so operators reading only `l1-launch-authorization.json` cannot miss mining-issuance audit, target-hardware capacity, independent succession, mining contention/calibration, immutable mining economics, sustained public-testnet mining retest, or protected release/tag review. Activation flags were not changed: `publicTestnetActivationAllowed=false` and `mainnetActivationAllowed=false`.
