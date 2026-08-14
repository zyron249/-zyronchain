# Portable State-v2 resume streaming boundary

Portable State-v2 transfer already persists resumable chunks to bounded, descriptor-bound files. The remaining recovery-capacity risk is final assembly: the current production path reconstructs all `records[]` and `keyPreimages[]` in memory and then returns a second structured clone after anchored validation.

The bounded streaming primitives introduced for issue #383 consume a complete `PortableStateResumeStore` in explicit record/key batches without calling `bundle()` or constructing one full array. They fail closed on incomplete stores and validate batch bounds before any chunk read.

These primitives are **not an activation claim and are not yet the production install boundary**. Before #383 can close, the trusted portable-state validation/install path must consume these batches (or an equivalent reviewed SQLite/staging interface) while preserving:

- the externally pinned finalized tip hash and full-snapshot digest;
- authenticated State-v2 root/reachability validation;
- duplicate, unreachable and uncommitted-node rejection semantics;
- semantic key-preimage validation;
- crash/restart resume behavior and finalized-history authority.

The existing `bundle()` path and its full-memory materialization remain authoritative until that production wiring and target-scale memory evidence are complete. Public-testnet and mainnet activation gates remain unchanged.
