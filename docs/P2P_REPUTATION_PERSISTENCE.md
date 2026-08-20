# Native peer reputation persistence

The native P2P reputation snapshot is a bounded local availability cache, not consensus state and not an activation-readiness signal.

Persistence uses a crash-safe temporary file, file `fsync`, and atomic rename. On platforms that support opening and synchronizing the parent directory, ZyronChain also `fsync`s that directory after the rename so the directory entry has the strongest available durability boundary.

Windows is intentionally different: Node.js cannot rely on the same parent-directory `fsync` behavior there. The native reputation store therefore skips only the parent-directory synchronization step on `win32`, matching the existing HTTP peer reputation portability boundary. File-level synchronization, atomic rename, bounded snapshot size, fail-closed corrupt-state handling, peer penalty semantics, and the 256-entry identity bound remain unchanged.

This portability exception must not be described as stronger Windows durability evidence. It prevents a supported Windows node from failing an otherwise successful reputation update solely because parent-directory synchronization is unavailable. Consensus/finality, validator custody, public-testnet, mainnet, and public-mining gates are unaffected.
