# Miner release manifest snapshot boundary

Miner release checksum publication is fail-closed against pathname replacement and in-place mutation of regular candidate files.

Before hashing each manifest input, the generator requires the pathname to resolve inside the canonical release root, requires the final entry to remain a regular file, and binds the opened descriptor to the validated device/inode, byte-size, modification-time, and change-time snapshot. SHA-256 bytes are read from that descriptor rather than from a later pathname lookup. After hashing completes, the descriptor snapshot is checked again; mutation during hashing aborts manifest publication.

This rule complements strict non-regular-entry rejection and `SHA256SUMS` self-exclusion. It does not replace runtime-tree source confinement, platform signing/notarization, provenance, immutable-release review, publication authorization, or explicit public-mining activation. Passing this boundary is release-candidate integrity evidence only and is not public-mining, public-testnet, or mainnet readiness evidence.
