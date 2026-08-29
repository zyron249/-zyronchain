# Miner packaging quarantine

## Security/readiness status

Self-contained miner artifact materialization is intentionally disabled until issue #761 supplies true handle-relative filesystem custody for the release root, bundle root, and nested destination directories.

The current pathname-based packager cannot truthfully satisfy the zero-external-byte replacement guarantees required by #757, #683, and #636. Rechecking `lstat`/`realpath` or narrowing the race window is not an acceptable substitute.

While this quarantine is active:

- `l1/scripts/package-miner.mjs` fails closed before binding or creating `l1/miner-release`;
- there is no unsafe environment or CLI bypass;
- Miner Package CI and Miner Release Candidate CI exercise the fail-closed gate on supported operating systems instead of publishing candidate bundles;
- no SBOM/checksum/attestation produced by those workflows may be interpreted as miner release evidence because no miner candidate is materialized;
- public mining activation remains independently gated and false;
- #761, #757, #683 and #636 remain open.

## Exit gate

A reviewed change may remove the quarantine only after all supported platforms have an audited handle/descriptor-relative implementation and adversarial tests prove release-root, bundle-root and nested-directory replacement cannot cause even one candidate byte to be written outside the bound release tree. The replacement change must pass the general ZyronChain CI, Standalone L1 Node 22/24, Miner Package CI, Miner Release Candidate CI, and every other applicable security/readiness gate on one fixed head SHA.

This document is a containment/readiness record. It does not claim that public mining, public testnet, or mainnet is ready.
