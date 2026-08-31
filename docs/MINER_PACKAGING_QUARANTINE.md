# Miner packaging custody status

## Security/readiness status

The temporary all-platform miner packaging quarantine has been retired after completion of #761, #757, #683 and #636 with fixed-head CI evidence. This does **not** activate public mining or authorize release publication.

Linux and macOS candidate materialization now proceed only through the audited POSIX descriptor-relative custody implementation under `l1/native/miner-custody-posix.c` and `l1/scripts/materialize-miner-package-posix.mjs`. The release root is retained by descriptor, bundle and nested destination directories are created/traversed relative to retained descriptors, destination file creation is no-follow/exclusive, and source bytes are read through retained source-directory/file descriptors.

Adversarial regressions cover release-root replacement, bundle-root replacement, nested destination replacement, source-root replacement, nested source-directory replacement and source-file replacement. External sentinels must receive zero candidate bytes.

Windows and any other non-audited platform remain explicitly fail-closed before release-root binding or candidate filesystem creation. There is no pathname-only fallback and no environment/CLI bypass.

Miner Package CI exercises the custody primitive/materializer across the supported matrix. Miner Release Candidate CI now also invokes the canonical `scripts/package-miner.mjs` entrypoint on Linux/macOS, requires exactly one local candidate beneath `l1/miner-release`, and re-checks that the bundled network profile remains inactive (`publicMiningActivated=false`, no RPC URL, no genesis). On Windows the same canonical package entrypoint must fail closed before `miner-release` exists. The workflow has read-only contents permission and deliberately does not upload, attest, sign or publish the candidate.

## Independent activation/publication gates

Retiring the custody quarantine changes only whether a local release candidate may be constructed on audited platforms. It does not change any of the following stop-ships:

- public mining activation remains false until its readiness/governance gates are intentionally satisfied;
- public testnet and mainnet activation remain fail-closed;
- signing, provenance/attestation, checksum/SBOM, immutable-release and publication policies remain required;
- Windows remains unsupported until an audited handle-relative/reparse-safe implementation exists;
- release hosting and website download UX must not present mining as live merely because candidate construction is possible.

Normal package construction must continue to fail closed if the descriptor-relative custody helper cannot be built or invoked safely.

This document records release-candidate custody capability only. It is not evidence that public mining, public testnet, or mainnet is ready.
