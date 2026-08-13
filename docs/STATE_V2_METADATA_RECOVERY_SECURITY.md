# State-v2 metadata recovery security

Status: **pre-public-testnet recovery hardening**

State-v2 root and backend marker files are small, fixed-shape local metadata used during startup and migration. They are not trusted merely because they exist on disk.

## Invariants

- `state-v2.root.json`, `state-v2.backend.json`, and `state-v2.keys.backend.json` are read through one opened descriptor rather than an unbounded path-based `readFile()`.
- Reads are capped at 4 KiB with a one-byte sentinel; files already larger than the cap are rejected before content allocation and concurrent growth beyond the cap is rejected while reading.
- On POSIX, `O_NOFOLLOW` prevents symlink substitution and `O_NONBLOCK` prevents a substituted special file such as a FIFO from blocking startup. The opened object must be a regular file.
- Existing checksum validation, authenticated root reconstruction, SQLite migration markers, fsync/rename publication ordering, and fail-closed corruption behavior remain unchanged.

## Evidence

`l1/test/state-v2-metadata-security.test.ts` covers exact-boundary input, oversized metadata, and POSIX symlink rejection. Existing State-v2 persistence and migration tests continue to cover root authentication, crash recovery, and migration semantics.

These controls do not authorize public mining, public testnet, mainnet, or production validator operation. External activation evidence remains mandatory.
