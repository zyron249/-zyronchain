# Portable State-v2 resume streaming boundary

Portable State-v2 transfer already persists resumable chunks to bounded, descriptor-bound files. The remaining recovery-capacity risk is final assembly: the current production fetch path still reconstructs all `records[]` and `keyPreimages[]` in memory and then returns a second structured clone after anchored validation.

The bounded streaming primitives introduced for issue #383 consume a complete `PortableStateResumeStore` in explicit record/key batches without calling `bundle()` or constructing one full array. They fail closed on incomplete stores and validate batch bounds before any chunk read.

The staging validator covers both records and semantic keys. Portable node records are parsed under the same canonical shape/value-size rules as the existing bundle validator, imported into the SQLite object store in bounded batches, and authenticated from the pinned State-v2 root with file-backed traversal bookkeeping. Durable row count and reachable-node count must both equal the manifest record count, so duplicate hashes and extra unreachable/uncommitted nodes fail closed without an O(n) JavaScript hash set.

Semantic-key preimages are likewise parsed and imported in bounded batches. SQLite key-hash uniqueness plus file-backed root traversal proves every reachable leaf has a preimage. The durable semantic-key count must equal both the manifest key count and the reachable leaf count, so duplicate, missing and extra/uncommitted preimages fail closed without first constructing a full `keyPreimages[]` bundle.

Canonical ledger/governance reconstruction consumes the authenticated stage by streaming semantic keys in bounded batches. It does not reconstruct a full `keyPreimages[]` array or a second JavaScript leaf-hash identity set. Every streamed semantic key is resolved against the staged authenticated root, the canonical ledger/governance ordering and uniqueness rules are reproduced, and the reconstructed view must reproduce the exact State-v2 root. The canonical ledger/governance arrays themselves remain necessary because the trusted checkpoint snapshot and governance validation model still consume that semantic view.

The authenticated resume store can now cross a real install boundary without `bundle()` materialization: `installTrustedPortableResume()` validates the original external tip/digest anchor through the streamed trust bridge and publishes the reconstructed canonical snapshot through `ChainStore.installTrustedSnapshot()`. That installer retains the existing staged-directory fsync, recovery re-open verification, no-overwrite check and atomic directory publication semantics. Disposable validation staging is removed on both success and failure, while the resumable transport store is left intact for the caller's poison/failover policy.

This is **not yet an activation claim and not yet the production fetch boundary**. Before #383 can close, `fetchTrustedPortableState*` / CLI `state-fetch-install` must use the authenticated resume-store install path directly instead of assembling and returning the legacy portable bundle. That final wiring must preserve:

- the externally pinned finalized tip hash and full-snapshot digest;
- authenticated State-v2 root/reachability validation;
- duplicate, unreachable and uncommitted-node rejection semantics;
- semantic key-preimage validation and exact completeness;
- canonical ledger/governance reconstruction and checkpoint finality validation;
- poison discard/peer failover behavior;
- crash/restart resume behavior and finalized-history authority.

The legacy production fetch path still calls `bundle()` and therefore remains the stop-ship item for #383. Final merge requires that wiring to be removed, fresh fixed-head general ZyronChain CI and Standalone L1 Node 22/24, and target-scale peak-memory evidence. Public-testnet and mainnet activation gates remain unchanged.
