# Miner checksum manifest publication security

`SHA256SUMS` is release-candidate integrity evidence and must not be published through a leaf pathname that can be redirected by a raced symlink.

The generator writes each manifest into a freshly and exclusively created temporary regular file inside the canonical release root, requests no-follow semantics where the platform exposes them, fsyncs the file when supported, then atomically renames that temporary file onto the `SHA256SUMS` leaf. A raced leaf symlink is therefore replaced as a directory entry rather than followed as a write target. The final leaf must resolve to a regular file contained by the canonical release root before generation succeeds.

This boundary preserves deterministic regeneration over an existing regular `SHA256SUMS`, release-root-relative path serialization, ASCII control-character rejection, descriptor-bound input hashing and snapshot validation, and non-regular/symlink input rejection. On POSIX, literal backslashes inside filenames are also rejected rather than silently rewritten into `/` separators or delegated to checksum-tool-specific escape parsing; Windows path separators continue to normalize canonically to `/` in the manifest.

This hardening does not prove platform signing, provenance, immutable publication, public-mining activation, public-testnet readiness, or mainnet readiness. Those gates remain independent and fail closed.
