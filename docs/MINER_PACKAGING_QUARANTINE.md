# Miner packaging quarantine

## Security/readiness status

Self-contained miner artifact materialization remains intentionally disabled until issue #761 supplies complete, cross-platform evidence for true handle-relative filesystem custody of the release root, bundle root, and nested destination directories.

The former pathname-based packager could not truthfully satisfy the zero-external-byte replacement guarantees required by #757, #683, and #636. Rechecking `lstat`/`realpath` or narrowing the race window is not an acceptable substitute.

A POSIX descriptor-relative custody implementation exists under `l1/native/miner-custody-posix.c`. It binds the release-root descriptor once, descends with retained directory descriptors, creates destinations exclusively with `mkdirat`/`openat(...O_NOFOLLOW)`, and copies regular-file bytes into retained destination descriptors. Destination custody now fails closed at build time when `O_NOFOLLOW` is unavailable instead of substituting a zero-valued fallback, and every opened root/nested directory descriptor is verified with `fstat()`/`S_ISDIR` rather than relying on a potentially unavailable `O_DIRECTORY` flag. Adversarial probes cover release-root, bundle-root, and nested-directory pathname replacement and require zero candidate bytes at the external sentinel.

`l1/scripts/materialize-miner-package-posix.mjs` maps the existing POSIX miner package layout onto that retained session: the runtime binary, `dist/src`, the existing four-script allowlist, network profile, `node_modules`, package metadata, launcher and README are emitted from retained source-directory descriptors into retained destination descriptors. Recursive source traversal rejects unsupported entries and source symlinks, and an existing bundle directory is not deleted or reused. `package-miner.mjs` is routed to this materializer after the activation gate rather than to pathname-based `rm/mkdir/cp/writeFile/chmod` operations.

Miner Package CI and Miner Release Candidate CI exercise both the low-level custody primitive and the package materializer on Linux/macOS. Their Windows jobs now execute the materializer entry point and require the exact unsupported-platform rejection before the candidate root or release tree is created; Windows is therefore explicitly unsupported rather than silently skipped or allowed to fall back to pathname materialization.

The quarantine itself is unchanged: `assertMinerPackagingCustodyReady()` still throws before binding or materializing `l1/miner-release`, so no miner release candidate is produced by normal packaging workflows.

While this quarantine is active:

- there is no unsafe environment or CLI bypass;
- no candidate bundle is published or treated as release evidence;
- public mining activation remains independently gated and false;
- Windows has no audited handle-relative implementation and remains explicitly fail-closed before candidate filesystem state is created;
- #761, #757, #683 and #636 remain open pending completion review and fixed-SHA CI evidence.

## Exit gate

The quarantine may be removed only after reviewed adversarial tests prove the real package materialization path cannot write even one candidate byte outside the bound release tree under release-root, bundle-root and nested-directory replacement, and every supported release platform has an audited handle-relative implementation or explicitly remains unsupported. The activation change must pass general ZyronChain CI, Standalone L1 Node 22/24, Miner Package CI, Miner Release Candidate CI and every other applicable security/readiness gate on one fixed head SHA.

This document is a containment/readiness record. It does not claim that public mining, public testnet, or mainnet is ready.
