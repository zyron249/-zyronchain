# Miner release output-root custody

The self-contained miner packager treats `l1/miner-release` as a security boundary, not as an arbitrary output path.

## Current status: materialization quarantined

Miner bundle materialization remains intentionally fail-closed while issue #761 is open. `package-miner.mjs` invokes the custody gate **before** `bindMinerReleaseRoot()` and before descriptor-relative materialization; the gate has no environment-variable or CLI bypass. Miner Package CI and Miner Release Candidate CI prove that normal packager invocation still fails with the custody-quarantine error and does not create a release candidate.

The dormant post-gate POSIX path is no longer a pathname `rm/mkdir/cp/writeFile/chmod` pipeline. After static release-root admission it delegates to `materialize-miner-package-posix.mjs`, which binds the accepted release directory in the native custody session, reserves the bundle exclusively, retains nested directory descriptors and emits candidate files with descriptor-relative `COPY`. Existing bundles are not deleted or reused.

This is still containment plus implementation evidence, not activation. The quarantine must remain until the real materialization path has deterministic replacement tests for the release root, bundle root and nested destinations, and each release platform has audited handle-relative custody or is explicitly unsupported. Windows currently has no equivalent audited handle implementation and therefore remains fail-closed.

## Static admission boundary

`bindMinerReleaseRoot()` remains a static admission check before the descriptor session starts: a symlink or non-directory release root is rejected fail closed, and the accepted path must canonically resolve to the `miner-release` child of the canonical L1 project root.

That admission check is not itself stable directory-handle custody. The security guarantee for subsequent POSIX destination operations comes from the retained descriptor session; code must not fall back to pathname mutation after admission.

The quarantine does not alter miner-network activation, signing, protocol-v5 consensus rules, checksums, SBOM requirements, immutable-release policy, or website publication gates. While quarantine is active, no self-contained miner candidate is produced by the normal packaging entry point. Green CI for this work is not evidence that public mining, public testnet, or mainnet is ready.
