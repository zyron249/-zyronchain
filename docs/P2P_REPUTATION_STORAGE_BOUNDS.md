# Peer reputation storage bounds

Status: **pre-public-testnet RPC/P2P DoS control**

ZyronChain persists HTTP peer and native libp2p reputation so active penalties survive restart. Logical cardinality remains capped at 256 entries, and persisted byte size is also bounded before UTF-8/JSON materialization.

## Invariants

- `peer-reputation.json` and `native-peer-reputation.json` are read through one opened file descriptor with a **2 MiB maximum**.
- Metadata that already exceeds the cap is rejected before allocating the bounded read buffer; concurrent growth beyond the cap also fails closed.
- Both stores verify their own serialized snapshots are below the same cap before persistence.
- HTTP reputation endpoints are limited to **4 KiB UTF-8** before and after URL normalization, preventing one endpoint from expanding project-written snapshots without bound.
- Native PeerId validation and its existing 256-entry cardinality limit remain unchanged.
- Active reputation penalties are not evicted merely to admit attacker-rotated identities; existing fail-closed capacity behavior remains authoritative.
- Oversized or malformed persisted reputation state fails startup for that store; it is never truncated or silently reset.

## Evidence

- `l1/test/bounded-file.test.ts` verifies exact-boundary acceptance and one-byte-over rejection.
- `l1/test/peer-reputation.test.ts` covers oversized HTTP reputation state and endpoint byte limits in addition to capacity/restart behavior.
- `l1/test/p2p-reputation.test.ts` covers oversized native reputation state in addition to protocol-ban and capacity/restart behavior.

This control is availability and peer-abuse hardening only. It does not authorize public mining, public testnet, mainnet, or production validator operation.