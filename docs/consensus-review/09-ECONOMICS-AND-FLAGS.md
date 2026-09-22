# Economics and flags

These values are pins. This qualification does not change them.

| Pin | Value | Where |
|---|---|---|
| Max supply | 50_000_000 ZYN | `MAX_SUPPLY_ATOMS = 50_000_000 * ATOMS_PER_ZYN` in `l1/src/types.ts` |
| Initial mining reward | 6.25 ZYN | `INITIAL_MINING_REWARD_ATOMS` in `l1/src/mining.ts` |
| Era length | 4_000_000 claims | `MINING_ERA_TARGET_CLAIMS` |
| Difficulty | 20 bits | `MINING_DIFFICULTY_BITS` |
| Claims per block | 1 | `chain.ts` throws `Block contains more than one mining claim` |
| Mining protocol | 5 | `MINING_PROTOCOL_VERSION` |
| Upgrade delay | 100 | `MIN_PROTOCOL_UPDATE_DELAY` |

Flags that stay false:

| Flag | File |
|---|---|
| `publicTestnetActivationAllowed` | `docs/l1-launch-authorization.json` |
| `mainnetActivationAllowed` | `docs/l1-launch-authorization.json` |
| `publicMiningActivated` | `l1/config/public-testnet-identity.json` and `l1/miner-network-profile.json` |
| `publicationAllowed` | `l1/config/public-testnet-identity.json` and `l1/deploy/public-testnet/release/pipeline.json` |

`ROUND0_DOUBLE_HASH_CLASSIFICATION.activation` remains `BLOCKS PUBLIC TESTNET`. The string `STOP-SHIP REVIEW` remains in the provisioning copy that `public-testnet-provisioning.test.ts` matches. Removing it would be an activation-shaped edit and was not done.

A 50-miner accounting rehearsal lives in `public-testnet-readiness.test.ts` (`runMinerWorkload` with `cohortSize: 50`). Re-run it on the current head before claiming the pin. It is an accounting harness, not a public mining launch.
