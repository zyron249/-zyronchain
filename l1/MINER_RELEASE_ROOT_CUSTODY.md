# Miner release output-root custody

The self-contained miner packager treats `l1/miner-release` as a security boundary, not as an arbitrary output path.

Before any platform bundle is removed, created, copied, or written, `package-miner.mjs` requires the release root to already exist as a real directory. A symlink or non-directory release root is rejected fail closed. The accepted root is resolved canonically and must be the `miner-release` child of the canonical L1 project root; package output paths are then built from that canonical root.

This protects the static package-output admission boundary from a pre-seeded release-root symlink redirecting cleanup or package writes outside the intended release tree. The regression suite covers a normal directory, a directory symlink/junction to an external target, and a non-directory root, and verifies the external sentinel is not modified when admission fails.

This hardening does **not** close issue #636. A separate destination-directory race can exist after a valid release root has been admitted, while nested runtime materialization is in progress. That issue retains its stronger requirement that a raced destination replacement cannot cause even one byte to be written outside the candidate root; this document does not weaken that requirement.

The change also does not alter miner-network activation, signing, provenance, checksum, SBOM, immutable-release, or website publication gates. Passing this boundary is release-candidate integrity evidence only and is not evidence that public mining, public testnet, or mainnet is ready.
