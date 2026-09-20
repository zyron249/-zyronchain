# ZyronChain launch authorization

Status: **governance authorization granted; activation remains evidence-gated**.

The repository records explicit authorization for both network classes:

- public testnet: **authorized**;
- mainnet: **authorized**.

Authorization means the project is permitted to prepare, coordinate and execute those network classes. It does **not** mean missing safety evidence is waived, and it does not by itself activate a value-bearing network.

`docs/l1-launch-authorization.json` is the machine-readable authority. It deliberately keeps `publicTestnetActivationAllowed=false` and `mainnetActivationAllowed=false` until the listed activation requirements are independently closed with evidence.

For public testnet, this preserves the independent-operator, infrastructure-diversity, external-audit **including protocol-v5 mining issuance**, sustained-Internet-soak, production-signer-custody, repository-policy, target-hardware capacity, independent succession, and mining contention/calibration gates.

For mainnet, it additionally preserves immutable chain identity/genesis allocation, immutable mining reward/halving/cap/difficulty policy, validator/economic/oracle governance, sustained public-testnet mining evidence, multi-region recovery drills, independent succession/custody evidence, and protected release/tag/branch review.

The operator-facing ready-vs-blocked map is [`PUBLIC_LAUNCH_CHECKLIST.md`](PUBLIC_LAUNCH_CHECKLIST.md). That checklist does not waive any gate and does not flip activation flags.

This separation prevents a governance authorization from being misrepresented as technical certification. No testnet balance becomes economically valuable merely because authorization exists, and no mainnet genesis may be improvised from development allocations.
