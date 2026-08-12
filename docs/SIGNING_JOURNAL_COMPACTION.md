# Signing journal compaction

Validator anti-equivocation state is durably reserved before any local or remote signature is released. The signing journal is append-only while a consensus height is live, but reservations at or below the node's **durably finalized height** are no longer signable and may be compacted.

## Safety boundary

Compaction is invoked only after `ChainStore.commitFinalizedBlock()` has returned. That method fsyncs the finalized block before advancing the in-memory chain, so `NodeService` passes only the authenticated durable finalized height to the journal. All validator mutation paths are serialized through `NodeService.exclusive()`.

The journal never evicts a live/future `(height, round)` reservation. Retained reservations preserve the existing anti-double-sign rule across restart.

## Crash-durable initialization

A missing `signing-journal.ndjson` is created exclusively with owner-only (`0600`) permissions. Before `SigningJournal.open()` may return, the empty journal file is fsynced and its parent directory is fsynced so the initial directory entry is durably published. Existing journals also cross the parent-directory sync boundary during startup before validator signing is enabled.

If journal initialization or the directory durability boundary fails, startup fails closed and the signing-journal lease is released. No validator signature may be produced from an ambiguously published journal path. A later clean startup replays the existing journal and repeats the directory durability boundary before signing is enabled.

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

Regression tests cover crash-durable journal initialization, directory-publication fault injection, finalized-only compaction, retained reservation replay after restart, failure before rename, failure after rename, and invalid compaction boundaries. These tests are project evidence only; they do not replace independent consensus review or change public-testnet/mainnet activation gates.
