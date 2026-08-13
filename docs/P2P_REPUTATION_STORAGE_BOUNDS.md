# Peer reputation storage bounds

Status: **pre-public-testnet RPC/P2P DoS control**

ZyronChain persists HTTP peer and native libp2p reputation so active penalties survive restart. Logical cardinality remains capped at 256 entries, persisted byte size is bounded before UTF-8/JSON materialization, and supported POSIX HTTP reputation publication includes directory-entry durability.

## Invariants

- `peer-reputation.json` and `native-peer-reputation.json` are read through one opened file descriptor with a **2 MiB maximum**.
- Metadata that already exceeds the cap is rejected before allocating the bounded read buffer; concurrent growth beyond the cap also fails closed.
- Both stores verify their own serialized snapshots are below the same cap before persistence.
- HTTP reputation endpoints are limited to **4 KiB UTF-8** before and after URL normalization, preventing one endpoint from expanding project-written snapshots without bound.
- On platforms where Node supports directory fsync (the supported POSIX production path), HTTP reputation publication writes an owner-only temporary file, fsyncs it, atomically renames it and fsyncs the parent directory before reporting success.
- Windows does not provide the same directory-fsync primitive through Node. Non-signing HTTP nodes therefore retain atomic file publication and file fsync there without failing the runtime peer-sync loop; the stronger post-rename directory-durability claim is not made for Windows.
- A pre-rename HTTP publication failure removes the unpublished temporary file. On the supported POSIX durability path, a failure after rename or during directory sync is surfaced to the caller rather than being reported as a durably completed mutation.
- Native PeerId validation and its existing 256-entry cardinality limit remain unchanged.
- Active reputation penalties are not evicted merely to admit attacker-rotated identities; existing fail-closed capacity behavior remains authoritative.
- Oversized or malformed persisted reputation state fails startup for that store; it is never truncated or silently reset.

## Evidence

- `l1/test/bounded-file.test.ts` verifies exact-boundary acceptance and one-byte-over rejection.
- `l1/test/peer-reputation.test.ts` covers oversized HTTP reputation state, endpoint byte limits, temporary cleanup, post-rename fault surfacing, supported-platform directory-sync completion, Windows support-boundary classification and restart behavior.
- `l1/test/p2p-reputation.test.ts` covers oversized native reputation state in addition to protocol-ban and capacity/restart behavior.

This control is availability and peer-abuse hardening only. It does not authorize public mining, public testnet, mainnet, or production validator operation.
