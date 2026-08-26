# Durable State-v2 cache accounting boundary

ZyronChain bounds the dedicated durable State-v2 serving cache by both entry count and aggregate regular-file bytes. Byte accounting is fail-closed and is not a trust source for checkpoint adoption.

Regular files are not trusted from pathname metadata alone. After discovery, each file is opened and its descriptor is checked against the original pathname snapshot. Device/inode identity, regular-file type, size, mtime and ctime must remain stable across the accounting boundary. POSIX opens use `O_NOFOLLOW`, and the pathname is revalidated against the opened descriptor before the byte size is accepted. A raced replacement, symlink substitution, growth/truncation or same-inode metadata mutation is rejected rather than silently undercounted.

The existing cache invariants remain unchanged:

- canonical checkpoint directories use the exact `<tipHash>-<snapshotSha256>` naming contract;
- symlinks and non-regular filesystem objects fail closed;
- protected/in-use checkpoints are never evicted to satisfy quota;
- at most two canonical checkpoints are retained;
- aggregate retained regular-file bytes remain capped at 512 MiB;
- non-canonical stale material is removed only after the cache root and protected paths have been fully validated.

This is local recovery/P2P resource-accounting hardening only. It does not establish target-hardware recovery readiness and is not evidence for public testnet or mainnet activation.
