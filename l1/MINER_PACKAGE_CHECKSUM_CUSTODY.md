# Miner Package checksum custody

`Miner Package CI` and `Miner Release Candidate CI` must use the same hardened checksum publication primitive: `scripts/generate-miner-sha256sums.mjs`.

The Miner Package workflow is not allowed to replace that boundary with an inline recursive pathname walker or direct `readFileSync()` hashing. The canonical generator provides regular-file and symlink rejection, descriptor-bound file snapshot validation, canonical release-root-relative path serialization, control/backslash rejection, stale publication-temporary rejection, deterministic ordering, and atomic `SHA256SUMS` publication.

The Linux, Windows, and macOS Miner Package matrix runs the canonical manifest regression scripts before packaging and publication. Action-custody verification requires those regressions and the canonical generator command, and rejects the previous inline pathname-hashing pattern.

Miner Package artifacts remain non-publishable CI evidence. This hardening does not change miner activation, signing, provenance, immutable-release, website publication, public-testnet, or mainnet gates, and it must not be cited as public-mining readiness evidence.
