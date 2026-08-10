# Standalone L1 private-testnet internal preflight

Status: **internal engineering preflight only**. Passing this preflight does not authorize a public testnet, mainnet, validator admission, production key creation or any external deployment.

## Purpose

The standalone L1 now has separate executable evidence for adversarial consensus faults, process crash/recovery, protocol upgrade/rollback, checkpoint disaster recovery, validator-key replacement and an external-audit handoff. This preflight binds those internal controls to the repository's launch-safety statements so a future change cannot silently remove a required control or turn an internal engineering result into public-launch authorization.

The machine-readable policy is `docs/l1-private-testnet-preflight.json`. The verifier is `l1/scripts/verify-private-testnet-preflight.mjs`.

## What the verifier requires

The preflight fails closed unless all of the following remain true:

- the TypeScript `l1/` client is explicitly documented as canonical and the Python/Flask network remains labeled legacy;
- README, readiness and threat-model text continue to block public testnet/mainnet authorization;
- the L1 package still requires Node.js 22+ and Standalone L1 CI still exercises Node 22 and 24;
- independent light-client verification remains present;
- mixed-version upgrade/rollback, disaster recovery, 600-height composite adversarial soak and separate-process native P2P crash/recovery jobs remain required by CI;
- validator-key rotation CI remains present;
- machine-readable evidence documentation still lists every high-risk rehearsal;
- the operations runbook and threat model remain part of the required package;
- the external-audit handoff remains explicitly preparation-only and keeps independent audit/Internet-soak/production-custody gates open;
- irreversible mainnet chain/genesis/economic/governance decisions remain unresolved;
- the current permissioned PoA/BFT architecture is not silently relabeled or converted to PoW/mining.

The verifier hashes every policy/document/workflow file it relies on and emits an exact-commit machine-readable result. CI runs the verifier twice and requires byte-for-byte identical output before uploading a checksum-protected artifact for 90 days.

## Meaning of a green result

A green result means **internal private/adversarial testnet engineering preflight passed for the tested commit**. It is useful for handing a deterministic build/test package to future independent operators without allowing readiness language to drift.

It does **not** mean a public testnet may be launched. The result always contains:

- `publicTestnetAuthorized: false`
- `mainnetAuthorized: false`
- the unresolved external/operator/infrastructure gates
- the unresolved mainnet-only decisions

## External gates deliberately left open

The following cannot be honestly closed by this repository's CI alone:

1. independent operators deploying release artifacts without founder assistance;
2. bootstrap/archive/monitoring across genuinely independent failure domains;
3. State-v2 scale and recovery measurements on target deployment hardware;
4. independent consensus/cryptography/network audit and independent retest of findings;
5. sustained adversarial Internet soak with independent operators;
6. production HSM/audited signer custody and cross-host key rotation;
7. multi-region disaster-recovery/incident drills;
8. repository branch-protection and independent-review settings enforced by the hosting platform.

Mainnet additionally requires explicit human/governance decisions for immutable chain identity, genesis allocation, validator economics, oracle governance and validator admission/removal.
