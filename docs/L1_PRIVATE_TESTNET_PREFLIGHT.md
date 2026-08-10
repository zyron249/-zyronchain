# Standalone L1 private-testnet internal preflight

Status: **internal engineering preflight only**. Passing this preflight does not itself grant public-testnet/mainnet governance authorization, does not activate either network class, and does not authorize validator admission, production key creation or external deployment. Global network-class authorization is recorded separately in `docs/l1-launch-authorization.json`.

## Purpose

The standalone L1 has separate executable evidence for adversarial consensus faults, process crash/recovery, protocol upgrade/rollback, checkpoint disaster recovery, validator-key replacement, security/maintainer succession policy, release-artifact operation, scale regression and an external-audit handoff. This preflight binds those internal controls to the repository's launch-safety statements so a future change cannot silently remove a required control or turn an internal engineering result into activation approval.

The machine-readable profile policy is `docs/l1-private-testnet-preflight.json`. The verifier is `l1/scripts/verify-private-testnet-preflight.mjs`.

## What the verifier requires

The preflight fails closed unless all of the following remain true:

- the TypeScript `l1/` client is explicitly documented as canonical and the Python/Flask network remains labeled legacy;
- repository/readiness/threat-model text continues to keep **activation** evidence-gated even when global governance authorization exists;
- the private/adversarial profile itself retains `publicTestnetAuthorized:false` and `mainnetAuthorized:false`, so it cannot self-promote into a public network;
- the L1 package still requires Node.js 22+ and Standalone L1 CI still exercises Node 22 and 24;
- independent light-client verification remains present;
- mixed-version upgrade/rollback, disaster recovery, 600-height composite adversarial soak and separate-process native P2P crash/recovery jobs remain required by CI;
- validator-key rotation and machine-readable evidence controls remain present;
- the operations runbook and threat model remain part of the required package;
- root security disclosure plus maintainer/release succession policy remain present, require at least two genuinely independent custodians before public-testnet activation, and forbid a unique founder recovery/admin authority;
- succession CI remains present while actual independent maintainer/security/release/domain custody stays an external evidence gate;
- the external-audit handoff remains explicitly preparation-only and keeps independent audit/Internet-soak/production-custody gates open;
- irreversible mainnet chain/genesis/economic/governance decisions remain unresolved;
- the current permissioned PoA/BFT architecture is not silently relabeled or converted to PoW/mining.

The verifier hashes every policy/document/workflow file it relies on and emits an exact-commit machine-readable result. CI runs the verifier twice and requires byte-for-byte identical output before uploading a checksum-protected artifact.

## Meaning of a green result

A green result means **internal private/adversarial testnet engineering preflight passed for the tested commit**. It is useful for handing a deterministic build/test package to future independent operators without allowing readiness language to drift.

Its `publicTestnetAuthorized:false` and `mainnetAuthorized:false` fields are **profile-local non-authority flags**: they state that this private preflight cannot authorize a network. They do not override the separate global launch-authorization record, which currently grants governance authorization while leaving activation flags false.

A green private preflight therefore does **not** mean public testnet or mainnet activation is allowed. It still carries unresolved external/operator/infrastructure gates and unresolved mainnet-only decisions.

## External gates deliberately left open

The following cannot be honestly closed by this repository's synthetic/internal CI alone:

1. independent operators deploying release artifacts without founder assistance;
2. bootstrap/archive/monitoring across genuinely independent failure domains;
3. State-v2 scale and recovery measurements on target deployment hardware;
4. independent consensus/cryptography/network audit and independent retest of findings;
5. sustained adversarial Internet soak with independent operators and real reviewed always-on duration evidence;
6. production HSM/audited signer custody and cross-host key rotation;
7. multi-region disaster-recovery/incident drills;
8. repository branch-protection and independent-review settings enforced by the hosting platform;
9. at least two genuinely independent maintainer/security/release custodians plus rehearsed domain/checkpoint succession.

Mainnet additionally requires explicit human/governance decisions for immutable chain identity, genesis allocation, validator economics, oracle governance and validator admission/removal.
