# ZyronChain launch authorization

Status: **governance authorization granted; activation remains evidence-gated**.

The repository records explicit authorization for both network classes:

- public testnet: **authorized**;
- mainnet: **authorized**.

Authorization means the project is permitted to prepare, coordinate and execute those network classes. It does **not** mean missing safety evidence is waived, and it does not by itself activate a value-bearing network.

`docs/l1-launch-authorization.json` is the machine-readable authority. It deliberately keeps `publicTestnetActivationAllowed=false` and `mainnetActivationAllowed=false` until the listed activation requirements are independently closed with evidence.

For public testnet, this preserves the independent-operator, infrastructure-diversity, external-audit, sustained-Internet-soak, production-signer-custody and repository-policy gates.

For mainnet, it additionally preserves immutable chain identity/genesis allocation, validator/economic/oracle governance, target-hardware State-v2 evidence, multi-region recovery drills and independent succession/custody evidence.

This separation prevents a governance authorization from being misrepresented as technical certification. No testnet balance becomes economically valuable merely because authorization exists, and no mainnet genesis may be improvised from development allocations.
