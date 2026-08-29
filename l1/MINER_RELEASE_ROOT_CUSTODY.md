# Miner release output-root custody

The self-contained miner packager treats `l1/miner-release` as a security boundary, not as an arbitrary output path.

## Current status: materialization quarantined

Miner bundle materialization is intentionally fail-closed while issue #761 remains open. The existing release-root admission logic can reject a pre-seeded symlink/non-directory, but pathname validation cannot bind the admitted directory identity across later descendant writes. That leaves the replacement races tracked by #757, #683 and #636 unresolved.

`package-miner.mjs` therefore invokes the custody gate **before** `bindMinerReleaseRoot()` and before any `miner-release` mkdir/remove/copy/write/chmod operation. There is no environment-variable or CLI bypass for pathname-only packaging. Miner Package CI and Miner Release Candidate CI now prove on supported runners that invoking the packager fails with the custody-quarantine error and leaves `miner-release` absent.

This quarantine is containment, not the final fix. It must not be removed until #761 provides an audited handle/descriptor-relative primitive on every supported platform and the replacement regressions for #757/#683/#636 prove that no candidate byte can escape the validated release tree.

## Existing admission boundary

When handle-relative packaging is eventually enabled, `bindMinerReleaseRoot()` still provides a useful static admission check: a symlink or non-directory release root is rejected fail closed, and the accepted path must canonically resolve to the `miner-release` child of the canonical L1 project root.

That check protects against a pre-seeded release-root redirect but does not by itself close a replacement race after validation. It must never be described as equivalent to stable directory-handle custody.

The quarantine does not alter miner-network activation, signing, protocol-v5 consensus rules, checksums, SBOM requirements, immutable-release policy, or website publication gates. While quarantine is active, no self-contained miner candidate is produced at all. Green CI proves only that the unsafe materialization path remains disabled; it is not evidence that public mining, public testnet, or mainnet is ready.
