# Miner release output-root custody

The self-contained miner packager treats `l1/miner-release` as a security boundary, not as an arbitrary output path.

## Current status: materialization quarantined

Miner bundle materialization remains intentionally fail-closed while issue #761 is open. `package-miner.mjs` invokes the custody gate **before** `bindMinerReleaseRoot()` and before descriptor-relative materialization; the gate has no environment-variable or CLI bypass. Miner Package CI and Miner Release Candidate CI prove that normal packager invocation still fails with the custody-quarantine error and does not create a release candidate.

The dormant post-gate POSIX path is no longer a pathname `rm/mkdir/cp/writeFile/chmod` pipeline. After static release-root admission it delegates to `materialize-miner-package-posix.mjs`, which binds the accepted release directory in the native custody session, reserves the bundle exclusively, retains nested directory descriptors and emits candidate files with descriptor-relative operations. Candidate sources are also read from retained source-directory descriptors. Existing bundles are not deleted or reused.

Deterministic adversarial custody regression now covers all three destination replacement layers required by #761 on POSIX runners: release-root replacement after session binding, top-level bundle-root replacement after exclusive reservation and entry, and nested destination-directory replacement after entry. In each case the pathname is replaced with a symlink to an external sentinel while the session remains open; candidate writes continue only through the retained descriptor and the external sentinel must receive zero candidate bytes. Miner Package CI and Miner Release Candidate CI exercise this regression on Linux and macOS.

This is still containment plus implementation evidence, not activation. Windows currently has no equivalent audited handle-relative/reparse-safe implementation. The production packaging entry point remains globally quarantined before filesystem writes, and Windows CI separately verifies that no release candidate or publication action is produced. There is no pathname-only fallback.

## Static admission boundary

`bindMinerReleaseRoot()` remains a static admission check before the descriptor session starts: a symlink or non-directory release root is rejected fail closed, and the accepted path must canonically resolve to the `miner-release` child of the canonical L1 project root.

That admission check is not itself stable directory-handle custody. The security guarantee for subsequent POSIX destination operations comes from the retained descriptor session; code must not fall back to pathname mutation after admission.

The quarantine does not alter miner-network activation, signing, protocol-v5 consensus rules, checksums, SBOM requirements, immutable-release policy, or website publication gates. While quarantine is active, no self-contained miner candidate is produced by the normal packaging entry point. Green CI for this work is not evidence that public mining, public testnet, or mainnet is ready.
