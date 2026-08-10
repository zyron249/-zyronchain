# Standalone L1 validator-key rotation rehearsal

Status: pre-public-testnet engineering rehearsal. This document does **not** authorize production key creation, HSM enrollment, validator admission or a public testnet.

## Objective

Prove that the existing quorum-authorized delayed validator-set update can safely replace a validator signing key without allowing the retired key to continue signing after activation, and that the activated replacement survives restart.

## CI scenario

`l1/scripts/validator-key-rotation-rehearsal.mjs` uses deterministic non-production secp256k1 keys and:

1. starts with three validators;
2. obtains the required current-set approval for a validator-set update at height 1;
3. schedules the replacement for height 101, satisfying the 100-block governance delay;
4. proves the old set remains active through height 100;
5. proves the retired key is rejected when it attempts to attest at activation height 101;
6. finalizes height 101 with the activated replacement set;
7. proves the replacement key is the scheduled proposer at height 102 and successfully finalizes its proposal;
8. snapshots/restarts after activation and proves the rotated validator schedule is preserved;
9. continues finalization through height 120 with the replacement set;
10. emits checksum-protected machine-readable CI evidence under the `validator-key-rotation` scenario.

## Security boundary

This rehearsal validates consensus/governance key replacement semantics. It does not model a production HSM, remote-signer provider control plane, human custody ceremony, token/credential rotation, cross-host signer migration, hardware destruction, jurisdictional separation or compromise forensics.

Before mainnet-class use, independent operators must repeat the procedure using their audited production signer/HSM process, preserve old-signer audit evidence, demonstrate that the retired signer cannot issue accepted signatures after activation, and rehearse recovery without copying private key material between hosts.
