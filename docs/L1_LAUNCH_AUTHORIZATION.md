# ZyronChain launch authorization

Status: **governance authorization granted; activation remains evidence-gated**.

The repository records explicit authorization for both network classes:

- public testnet: **authorized**;
- mainnet: **authorized**.

Authorization means the project is permitted to prepare, coordinate and execute those network classes. It does **not** mean missing safety evidence is waived, and it does not by itself activate a value-bearing network.

`docs/l1-launch-authorization.json` is the machine-readable authority. It deliberately keeps `publicTestnetActivationAllowed=false` and `mainnetActivationAllowed=false` until the listed activation requirements are independently closed with evidence.

For public testnet, this preserves the independent-operator, infrastructure-diversity, external-audit **including protocol-v5 mining issuance**, sustained-Internet-soak, production-signer-custody, repository-policy, target-hardware capacity, independent succession, and mining contention/calibration gates.

For mainnet, it additionally preserves immutable chain identity/genesis allocation, immutable mining reward/halving/cap/difficulty policy, validator/economic/oracle governance, sustained public-testnet mining evidence, multi-region recovery drills, independent succession/custody evidence, and protected release/tag/branch review.

Mining is retired and the full 50,000,000 ZYN supply is allocated at genesis. The mining-related requirement IDs are kept unchanged in the machine-readable file; for mining they now mean evidence that `mining_claim` stays rejected on every path and protocol version and that supply never grows.

The four mining-related IDs are pinned by `l1/scripts/verify-launch-authorization.mjs`, so they are not renamed here (renaming them is a governance-record change that needs owner approval and a changelog entry). Their current meaning:

| Requirement ID (unchanged) | Current meaning after mining retirement |
|---|---|
| `independent-protocol-v5-mining-issuance-audit-and-retest` | Independent audit and retest that no `mining_claim` is accepted on any path under v1, v2, v3, v5 and v6, and that no mint path exists (total supply never exceeds the genesis allocation) |
| `mining-contention-calibration-and-inclusion-fairness-evidence` | Obsolete as a mining gate; closed only by evidence that mining stays retired in the released artifacts (miner disabled, claims rejected) |
| `immutable-mining-reward-halving-cap-and-difficulty-policy` | The frozen policy is "no mining issuance": a fixed 50,000,000 ZYN supply allocated in full at genesis |
| `sustained-public-testnet-mining-finality-and-independent-retest` | Sustained public-testnet finality evidence and independent retest; there is no mining component |

The operator-facing ready-vs-blocked map is [`PUBLIC_LAUNCH_CHECKLIST.md`](PUBLIC_LAUNCH_CHECKLIST.md). That checklist does not waive any gate and does not flip activation flags.

This separation prevents a governance authorization from being misrepresented as technical certification. No testnet balance becomes economically valuable merely because authorization exists, and no mainnet genesis may be improvised from development allocations.
