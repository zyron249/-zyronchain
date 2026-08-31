# Miner release output-root custody

The self-contained miner packager treats `l1/miner-release` as a security boundary, not as an arbitrary output path.

## Current status: audited POSIX local candidates only

Issues #761/#757/#683/#636 completed the retained-descriptor filesystem-custody work required to permit **local candidate materialization on audited Linux/macOS paths only**. `package-miner.mjs` still invokes the platform custody gate before binding the release root. Windows and other unaudited platforms remain fail-closed before `miner-release` state is created; there is no pathname-only fallback.

The POSIX materializer delegates destination mutation to `materialize-miner-package-posix.mjs`, which binds the accepted release directory in the native custody session, reserves the bundle exclusively, retains nested directory descriptors and emits candidate files with descriptor-relative operations. Candidate sources are read from retained source-directory descriptors. Existing bundles are not deleted or reused. npm `.bin` executable shims are omitted from the candidate rather than dereferenced, while arbitrary source symlinks remain rejected.

Deterministic adversarial custody regression covers release-root replacement after session binding, top-level bundle-root replacement after exclusive reservation and entry, and nested destination-directory replacement after entry. Candidate writes continue only through retained descriptors and external replacement targets must receive zero candidate bytes. Miner Package CI and Miner Release Candidate CI exercise the audited POSIX path.

## Candidate integrity binding

Every audited POSIX candidate is now bound to `candidate-integrity.json`. The manifest records schema version, package version, platform, architecture, the exact 40-character source commit, and a deterministic lexicographically sorted SHA-256 inventory of every regular candidate file except integrity/checksum metadata itself.

Integrity collection is fail-closed. Symlinks, non-regular entries, path escape, ambiguous path characters, invalid source identity, and file identity/content mutation across the hash boundary are rejected. The manifest is created through an exclusive temporary regular file and atomically renamed into the candidate, then immediately re-verified. CI independently re-verifies it and requires `sourceCommit` to equal the exact GitHub workflow SHA. Regression tests prove deterministic output, tamper detection, symlink rejection, invalid source-commit rejection, and unaudited-platform rejection.

This is local integrity evidence only. It is not signing, provenance attestation, publication, public-mining activation, public-testnet readiness, or mainnet readiness. `publicMiningActivated=false`, canonical RPC/genesis activation gates, release-signing requirements, immutable-release policy and website publication gates remain unchanged.

## Static admission boundary

`bindMinerReleaseRoot()` remains a static admission check before the descriptor session starts: a symlink or non-directory release root is rejected fail closed, and the accepted path must canonically resolve to the `miner-release` child of the canonical L1 project root.

That admission check is not itself stable directory-handle custody. The security guarantee for subsequent POSIX destination operations comes from the retained descriptor session; code must not fall back to pathname mutation after admission.
