# Signing journal compaction

Validator anti-equivocation state is durably reserved before any local or remote signature is released. The signing journal is append-only while a consensus height is live, but reservations at or below the node's **durably finalized height** are no longer signable and may be compacted.

## Safety boundary

Compaction is invoked only after `ChainStore.commitFinalizedBlock()` has returned. That method fsyncs the finalized block before advancing the in-memory chain, so `NodeService` passes only the authenticated durable finalized height to the journal. All validator mutation paths are serialized through `NodeService.exclusive()`.

The journal never evicts a live/future `(height, round)` reservation. Retained reservations preserve the existing anti-double-sign rule across restart.

## Crash-durable initialization

A missing `signing-journal.ndjson` is created exclusively with owner-only (`0600`) permissions and its empty file is fsynced. Before `SigningJournal.open()` may return, ZyronChain then fsyncs the resolved data-directory ancestry from the filesystem root through the validator data directory. This publishes both a newly created nested data directory and the journal's directory entry before signing is enabled. Existing journals cross the same ancestry durability boundary during startup.

Node's standard filesystem API does not expose the POSIX directory-fsync primitive used by this invariant on Windows. Validator signing therefore fails closed on `win32` rather than silently running with weaker anti-equivocation crash durability. This is a validator-signing support boundary, not an activation bypass; non-signing software may still use the rest of the portable L1 surface where supported.

If journal creation or any ancestry durability boundary fails, startup fails closed and the signing-journal lease is released. Corrupt existing journal history keeps its original replay error rather than being misclassified as an initialization failure. No validator signature may be produced from an ambiguously published journal path.

## Crash-durable replacement

`SigningJournal.compactThrough(height)` rewrites retained reservations through this sequence:

1. create a unique owner-only (`0600`) temporary journal;
2. stream retained records into the temporary file;
3. fsync the temporary file;
4. atomically rename it over `signing-journal.ndjson`;
5. fsync the parent directory;
6. only then remove finalized reservations from the in-memory map.

The rewrite does not concatenate the complete journal into one unbounded string.

Any persistence error after compaction starts marks the journal instance faulted. The validator refuses further signing until restart. A failure before rename leaves the old journal authoritative. A failure after rename is treated as ambiguous publication: the current instance still fail-stops, and startup replay is the only recovery boundary.

`/readyz` reports `signing-journal-unhealthy` when a live validator journal has entered this fail-stop state.

## Evidence boundary

Regression tests cover nested data-directory initialization, unsupported-platform fail-closed behavior, owner-only journal creation, ancestry-publication fault injection, finalized-only compaction, retained reservation replay after restart, failure before rename, failure after rename, and invalid compaction boundaries. These tests are project evidence only; they do not replace independent consensus review or change public-testnet/mainnet activation gates.
