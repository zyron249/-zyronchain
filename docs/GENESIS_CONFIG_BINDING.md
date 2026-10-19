# Genesis-configuration binding and the fixed-supply launch profile

Status: implemented, **not activated on any network**. This is a consensus and tokenomics change and needs explicit owner approval before merge. It has had a self-review only; it still needs an independent review.

Backlog items: P0-01 (bind the consensus-relevant genesis configuration into chain identity) and P0-02 (make the fixed-supply rules consensus rules for a launch genesis).

## Problem

Before this change:

- The genesis block hash committed only to `chainId`, `timestampMs` and the initial state root (balances). `validators`, `activityOracles`, `activityPool` and `allocationLocks` were not part of the chain identity. Two genesis files that differed only in those fields had the same genesis hash, so nodes running them peered normally (the P2P identity is `chainId` + `genesisHash`). A node whose genesis lacked `allocationLocks` accepted founder spends that the other nodes refused, so the chain forked silently or the locks were bypassed. The only mitigation was the procedural SHA-256 pin of the genesis file.
- `allocationLocks` was optional in consensus. Consensus enforced only "at most 50,000,000 ZYN". The rules "exactly 50,000,000 ZYN", "10/40/40/10 to four roles" and "locks present" were checked only by the offline verifier (`npm run tokenomics:check`).

## Design

A genesis opts in with one new optional field:

```json
{ "launchProfile": "fixed-supply-v1", ... }
```

Genesis files without the field (every existing devnet, testnet, rehearsal and test fixture) are unaffected: same validation, same genesis hash, byte for byte.

Under `fixed-supply-v1`:

1. **Full configuration commitment.** `genesisConfigCommitment(genesis) = SHA-256(canonicalJson({ domain: "zyronchain/genesis-config/v1", genesis }))`. `canonicalJson` sorts object keys and keeps array order, so the commitment does not depend on key order in the file but does bind the order of validators (which drives proposer selection). Every genesis field is included: chain ID, timestamp, validators, activity oracles, activity pool, allocations, `allocationLocks` and `launchProfile`. `validateGenesis` refuses unknown fields, so no consensus-relevant field can be left out.
2. **Carried in the genesis header.** The commitment is placed in the `previousHash` slot of the genesis header, which is otherwise all zeros. The header shape is unchanged, so block encoding, block validation, light-client and P2P code paths are unchanged. Because the genesis hash covers the header, the following all inherit the binding:
   - the P2P chain identity (`chainId` + `genesisHash`): a peer with any different configuration is refused at the identity handshake;
   - block 1's parent link: blocks built on a different configuration are refused;
   - store metadata: a data directory created for one configuration refuses to open with another;
   - checkpoint and snapshot anchors and light-client anchors, which pin `genesisHash`.
3. **Launch rules in consensus.** `validateGenesis` (run by `new ZyronChain`, and therefore by `ChainStore.open` at node startup) calls `assertFixedSupplyLaunchProfile`. It derives the four roles from the genesis itself: founder = `allocationLocks.founderVesting`, permanent liquidity = `allocationLocks.permanentLiquidity`, ecosystem/community = `activityPool`, public distribution = the single remaining allocation. It then applies the existing `assertFixedSupplyGenesis`: exactly four allocation accounts, 5,000,000 / 20,000,000 / 20,000,000 / 5,000,000 ZYN, total exactly 50,000,000 ZYN, `allocationLocks` naming exactly the founder and permanent-liquidity accounts, and the activity pool equal to the ecosystem account. Any other `launchProfile` value is refused.

Nothing about supply, allocations, the vesting schedule (365-day cliff, 1,095-day linear), the permanent-liquidity lock, the 10,000 ZYN per 24 h activity-settlement cap or the fee burn changes.

`npm run tokenomics:check` now also requires `launchProfile: "fixed-supply-v1"` on the launch genesis and prints the configuration commitment and the genesis hash. The ceremony should publish both values alongside the genesis file's SHA-256.

Declaring `networkClass` (network-class-v1) or `publicDistributionRelease` (public-distribution-release-v1) also places that same commitment in the genesis previous-hash slot. A file that omits `launchProfile`, `activityOracleThreshold`, `networkClass` and `publicDistributionRelease` keeps the historical zero previous hash. Adding `publicDistributionRelease` to a live devnet or testnet data directory changes the genesis hash; do not do that. The field and its schedule are specified in [`PUBLIC_DISTRIBUTION_RELEASE.md`](PUBLIC_DISTRIBUTION_RELEASE.md).

## What is not in the commitment

- **Protocol activation schedule.** ZyronChain has no genesis-level schedule; every chain starts at protocol v1 and later versions activate through on-chain `protocol_upgrade` governance, which is already part of block history. If a genesis-level schedule is ever added it becomes a genesis field and is therefore bound automatically.
- **Node-local settings** (P2P allowlists, RPC limits, signer configuration). These are not consensus rules.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| Add a `configHash` field to `BlockHeader` | Changes the header shape for every block and every decoder (TypeScript, Python light client, P2P), and needs a versioned header. Same security result with much more surface. |
| Commit the configuration for all genesis files | Changes the genesis hash of every existing devnet and testnet; existing data directories and anchors would stop opening. |
| Node-config pin (`--genesis-config-hash`) plus a P2P identity field | Optional, operator-dependent and outside block history; a misconfigured node still accepts the wrong configuration. |
| Enforce the fixed-supply rules by chain-ID class (for example `zyron-mainnet-*`) | Implicit and easy to sidestep with a new chain ID; an explicit field in the hashed genesis is auditable. |

## Trade-offs and residual risk

- **Opt-in for files that omit both the profile and a value-bearing class.** A genesis that omits `launchProfile` and does not declare `networkClass` `public-launch`, `value-bearing` or `mainnet` (and whose chain ID does not name one of those classes) still gets the legacy behaviour. That is required so existing devnets and testnets keep their genesis hash. A value-bearing class cannot use that path: node start refuses it unless `launchProfile` is `fixed-supply-v1`, which requires the locks. See [`GENESIS_NETWORK_CLASS.md`](GENESIS_NETWORK_CLASS.md). `tokenomics:check` fails closed without the profile and without a value-bearing network class. Operators should check that the published genesis hash matches what their node reports.
- **The previous-hash slot is overloaded at height 0.** Tools that assume the genesis `previousHash` is all zeros will see a non-zero value for profile chains. No code in this repository makes that assumption.
- **The profile is static.** The validator set can change after genesis through the existing on-chain `validator_update` transaction; the binding covers the starting configuration only. The activity-oracle set cannot change after genesis: there is no oracle-update transaction (transaction kinds are `transfer`, `activity_settlement`, `mining_claim`, `validator_update` and `protocol_upgrade`), and settlements are authorized against the immutable `genesis.activityOracles`. Replacing a compromised oracle key therefore requires a new protocol mechanism (consensus change, owner approval) or a new chain. Until then, the per-epoch cap (10,000 ZYN per closed 24 h epoch) and, once merged, the m-of-n threshold (#969) bound the damage from one compromised key.
- **Not yet independently reviewed or audited.**

## Tests

`l1/test/genesis-config-binding.test.ts`:

- five representative legacy genesis shapes keep the exact genesis hashes recorded on `b85571d`, and still follow the historical header formula with a zero previous hash;
- the profile genesis hash equals an independent recomputation of the commitment and is independent of key order;
- oracle swapped or added, validator swapped, added or reordered, and locks plus profile stripped each give a distinct genesis hash;
- a block from a tampered-oracle chain is refused, a data directory refuses a tampered configuration, and the native P2P identity handshake refuses a tampered peer;
- missing locks, wrong total, three wrong splits, a fifth or a missing account, a wrong activity pool, swapped lock roles and unknown or non-string profile values are refused at construction and at `ChainStore.open`.
