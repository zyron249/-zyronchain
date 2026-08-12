# Signing journal compaction

Validator anti-equivocation state is durably reserved before any local or remote signature is released. The signing journal is append-only while a consensus height is live, but reservations at or below the node's **durably finalized height** are no longer signable and may be compacted.

## Safety boundary

Compaction is invoked only after `ChainStore.commitFinalizedBlock()` has returned. That method fsyncs the finalized block before advancing the in-memory chain, so `NodeService` passes only the authenticated durable finalized height to the journal. All validator mutation paths are serialized through `NodeService.exclusive()`.

The journal never evicts a live/future `(height, round)` reservation. Retained reservations preserve the existing anti-double-sign rule across restart.

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

Regression tests cover finalized-only removal, retained reservation replay after restart, failure before rename, failure after rename, and invalid compaction boundaries. These tests are project evidence only; they do not replace independent consensus review or change public-testnet/mainnet activation gates.
