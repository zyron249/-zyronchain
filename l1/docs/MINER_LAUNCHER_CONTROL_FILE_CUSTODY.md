# Miner launcher control-file custody

Bundled miner control files are treated as package-owned security inputs, not as ordinary mutable configuration.

`readSafeBundledRegularFile()` requires the requested file to remain a regular non-symlink entry beneath the canonical miner package root. POSIX opens use no-follow/non-blocking flags, and pathname/canonical identity is revalidated around the descriptor read.

The opened descriptor is also bound to a content snapshot. The first read is sized to the descriptor's observed file size plus one overflow byte and remains subject to the absolute 64 KiB control-file ceiling. Before bytes are returned to the launcher, the same opened descriptor is read again in bounded chunks and compared byte-for-byte with the candidate bytes. Descriptor size/mtime/ctime identity is checked around the reads, and a one-byte trailing sentinel rejects concurrent growth. Same-inode mutation, truncation, growth, pathname replacement, or canonical-path drift therefore fails closed before control bytes reach the launcher.

The second-pass scratch allocation is bounded to 64 KiB; small files do not allocate the full control-file ceiling for the primary read.

This is local miner-launcher custody hardening only. It does not establish signed miner-release publication, public-mining activation, public-testnet readiness, or mainnet readiness, and it does not relax any existing release, signing, provenance, immutable-publication, or activation gate.