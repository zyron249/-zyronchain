# Portable State-v2 resume streaming boundary

Portable State-v2 transfer already persists resumable chunks to bounded, descriptor-bound files. The remaining recovery-capacity risk is final assembly: the current production path reconstructs all `records[]` and `keyPreimages[]` in memory and then returns a second structured clone after anchored validation.

The bounded streaming primitives introduced for issue #383 consume a complete `PortableStateResumeStore` in explicit record/key batches without calling `bundle()` or constructing one full array. They fail closed on incomplete stores and validate batch bounds before any chunk read.

The staging validator covers both records and semantic keys. Portable node records are parsed under the same canonical shape/value-size rules as the existing bundle validator, imported into the SQLite object store in bounded batches, and authenticated from the pinned State-v2 root with file-backed traversal bookkeeping. Durable row count and reachable-node count must both equal the manifest record count, so duplicate hashes and extra unreachable/uncommitted nodes fail closed without an O(n) JavaScript hash set.

Semantic-key preimages are likewise parsed and imported in bounded batches. SQLite key-hash uniqueness plus file-backed root traversal proves every reachable leaf has a preimage. The durable semantic-key count must equal both the manifest key count and the reachable leaf count, so duplicate, missing and extra/uncommitted preimages fail closed without first constructing a full `keyPreimages[]` bundle.

Canonical ledger/governance reconstruction can now consume the authenticated stage by streaming semantic keys in bounded batches. It does not reconstruct a full `keyPreimages[]` array or a second JavaScript leaf-hash identity set. Every streamed semantic key is resolved against the staged authenticated root, the canonical ledger/governance ordering and uniqueness rules are reproduced, and the reconstructed view must reproduce the exact State-v2 root. The canonical ledger/governance arrays themselves remain necessary because the trusted checkpoint snapshot and governance validation model still consume that semantic view.

These primitives are **not an activation claim and are not yet the production install boundary**. Before #383 can close, the trusted portable-state validation/install path must publish through this bounded staging + streamed-view path while preserving:

- the externally pinned finalized tip hash and full-snapshot digest;
- authenticated State-v2 root/reachability validation;
- duplicate, unreachable and uncommitted-node rejection semantics;
- semantic key-preimage validation and exact completeness;
- canonical ledger/governance reconstruction and checkpoint finality validation;
- crash/restart resume behavior and finalized-history authority.

The existing `bundle()` path and its full-memory materialization remain authoritative until production trusted-state wiring uses the bounded stage and streamed semantic reconstruction. Final merge also requires new fixed-head CI and target-scale peak-memory evidence; public-testnet and mainnet activation gates remain unchanged.
