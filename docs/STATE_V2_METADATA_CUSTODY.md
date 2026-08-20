# State-v2 metadata custody boundary

State-v2 root/backend metadata files are local non-secret recovery state, but their pathname and bytes still affect restart integrity and availability.

The supported reader uses the same descriptor-bound `readBoundedUtf8File()` primitive as other hardened local state files. It freezes the initial canonical path, rejects direct symbolic links, opens the reviewed file with POSIX `O_NOFOLLOW | O_NONBLOCK` where available, validates regular-file identity after open, bounds the read to the existing metadata byte limit, and revalidates the canonical path again before bytes are returned to a parser. On Windows this post-open/post-read canonical revalidation is the fail-closed boundary against raced parent junction/reparse substitution.

The default State-v2 metadata cap remains 4 KiB. Empty, oversized, concurrently grown, non-regular, symlinked, or path-substituted files are rejected before checksum/root/backend parsing can authorize them. Existing checksum validation, SQLite backend markers, crash-safe rename/fsync persistence, and authenticated State-v2 root semantics are unchanged.

This control protects local recovery-state integrity and availability. It does not replace filesystem ACLs, independent backup/recovery review, target-hardware State-v2 capacity evidence, or the public-testnet/mainnet activation gates tracked separately.