# Portable State-v2 resume streaming boundary

Portable State-v2 transfer already persists resumable chunks to bounded, descriptor-bound files. The remaining recovery-capacity risk is final assembly: the current production path reconstructs all `records[]` and `keyPreimages[]` in memory and then returns a second structured clone after anchored validation.

The bounded streaming primitives introduced for issue #383 consume a complete `PortableStateResumeStore` in explicit record/key batches without calling `bundle()` or constructing one full array. They fail closed on incomplete stores and validate batch bounds before any chunk read.

The record side now also has a disk-backed staging validator. Portable node records are parsed under the same canonical shape/value-size rules as the existing bundle validator, imported into the SQLite object store in bounded batches, and authenticated from the pinned State-v2 root with file-backed traversal bookkeeping. Durable row count and reachable-node count must both equal the manifest record count, so duplicate hashes and extra unreachable/uncommitted nodes fail closed without an O(n) JavaScript hash set.

These primitives are **not an activation claim and are not yet the production install boundary**. Before #383 can close, the trusted portable-state validation/install path must consume the staged records plus streamed semantic keys while preserving:

- the externally pinned finalized tip hash and full-snapshot digest;
- authenticated State-v2 root/reachability validation;
- duplicate, unreachable and uncommitted-node rejection semantics;
- semantic key-preimage validation and exact completeness;
- crash/restart resume behavior and finalized-history authority.

The existing `bundle()` path and its full-memory materialization remain authoritative until semantic-key/view reconstruction and production install wiring use the bounded staging path and target-scale peak-memory evidence is archived. Public-testnet and mainnet activation gates remain unchanged.
