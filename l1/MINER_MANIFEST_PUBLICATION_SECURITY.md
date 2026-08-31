# Miner checksum manifest publication security

`SHA256SUMS` is release-candidate integrity evidence and must not be published through a leaf pathname that can be redirected by a raced symlink.

The generator writes each manifest into a freshly and exclusively created temporary regular file inside the canonical release root, requests no-follow semantics where the platform exposes them, fsyncs the file when supported, then atomically renames that temporary file onto the `SHA256SUMS` leaf. A raced leaf symlink is therefore replaced as a directory entry rather than followed as a write target. The final leaf must resolve to a regular file contained by the canonical release root before generation succeeds.

Generation is now self-verifying. Immediately after atomic publication, the verifier reparses the on-disk `SHA256SUMS`, recollects the exact regular-file set beneath the canonical release root, rehashes each file through descriptor-bound no-follow reads, and requires the manifest to match the deterministic root-relative ordering and digest set exactly. Malformed checksum records, duplicate paths, traversal or ambiguous path syntax, missing or extra release files, digest mismatch, symlink/non-regular entries, stale publication temporaries, and a symlinked/non-regular `SHA256SUMS` leaf all fail closed.

This boundary preserves deterministic regeneration over an existing regular `SHA256SUMS`, release-root-relative path serialization, ASCII control-character rejection, descriptor-bound input hashing and snapshot validation, and non-regular/symlink input rejection. Manifest records always use canonical `/` separators and verification rejects literal backslashes rather than delegating ambiguous path interpretation to platform checksum tools.

The audited POSIX miner package and release-candidate CI paths generate and re-verify this checksum manifest only after `candidate-integrity.json` has already bound the candidate to its exact source commit. `SHA256SUMS` remains local evidence: it is not a signature, attestation, publication authorization, or activation signal.

This hardening does not prove platform signing, provenance, immutable publication, public-mining activation, public-testnet readiness, or mainnet readiness. Those gates remain independent and fail closed.
