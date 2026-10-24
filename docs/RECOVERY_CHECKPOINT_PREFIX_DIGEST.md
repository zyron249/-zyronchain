# Recovery checkpoint retained-prefix digest (v3)

`ChainStore.open` with a local `recovery-checkpoint.json` restores state from the checkpoint snapshot and only line-scans the finalized-log records below the checkpoint height; it replays and fully validates only the suffix above it. Before v3 the scan checked the tip record and the byte boundary but not the content of earlier records, so a same-length corruption of a historical block in `blocks.ndjson` (for example one flipped hash character) was accepted on the fast path and could then be served by `/blocks` or sealed into a later snapshot (finding R21-1046-L1).

Version 3 binds the bytes the fast path skips:

- `blockFilePrefixSha256` is the SHA-256 of `blocks.ndjson[0 .. blockFileBytes)`, the exact retained log bytes up to and including the checkpoint tip record (empty prefix for an empty retained log).
- During an interrupted prune, `transition.blockFilePrefixSha256` binds the old layout `[0 .. transition.blockFileBytes)`; the top-level digest binds the new suffix layout. Both are computed from one read of the log before the transition checkpoint is written.
- One layout covers unpruned and pruned logs: `retainedFromHeight` is 1 for an unpruned log, and `stateV2Root` is `null` only for an unpruned chain without active State v2 (otherwise it must equal the snapshot-backed root; pruned logs still need active State v2).
- The reader hashes the raw bytes the line scan already reads (no second pass) and compares the digest at the selected boundary before replaying any suffix block. A mismatch fails the fast path with the same error as a tip mismatch, so an unpruned store falls back to the authoritative full replay (which rejects the corrupted block) and a pruned store fails closed.

Compatibility: v1 and v2 checkpoints are still read unchanged (without a prefix digest; the next published checkpoint is v3). Binaries older than this change reject a v3 file: an unpruned store then falls back to a full replay, while a pruned store cannot open until it runs a binary that reads v3. Downgrading a pruned data directory is therefore not supported.

Scope: this detects accidental or local corruption of retained history. It is not a trust boundary against a party with write access to the data directory, which can rewrite the checkpoint as well.
