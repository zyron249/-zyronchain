# Portable State-v2 resume streaming boundary

Portable State-v2 transfer persists resumable chunks to bounded, descriptor-bound files. Issue #383 hardens the final recovery boundary so the supported production `state-fetch-install` path no longer reconstructs all portable `records[]` and `keyPreimages[]` in RAM or returns a second full structured clone before installation.

The bounded streaming primitives consume a complete `PortableStateResumeStore` in explicit record/key batches without calling `bundle()` or constructing one full portable array. They fail closed on incomplete stores and validate batch bounds before any chunk read.

The staging validator covers both records and semantic keys. Portable node records are parsed under the same canonical shape/value-size rules as the existing bundle validator, imported into the SQLite object store in bounded batches, and authenticated from the pinned State-v2 root with file-backed traversal bookkeeping. Durable row count and reachable-node count must both equal the manifest record count, so duplicate hashes and extra unreachable/uncommitted nodes fail closed without an O(n) JavaScript hash set.

Semantic-key preimages are likewise parsed and imported in bounded batches. SQLite key-hash uniqueness plus file-backed root traversal proves every reachable leaf has a preimage. The durable semantic-key count must equal both the manifest key count and the reachable leaf count, so duplicate, missing and extra/uncommitted preimages fail closed without first constructing a full `keyPreimages[]` bundle.

Canonical ledger/governance reconstruction consumes the authenticated stage by streaming semantic keys in bounded batches. It does not reconstruct a full `keyPreimages[]` array or a second JavaScript leaf-hash identity set. Every streamed semantic key is resolved against the staged authenticated root, the canonical ledger/governance ordering and uniqueness rules are reproduced, and the reconstructed view must reproduce the exact State-v2 root. The canonical ledger/governance arrays themselves remain necessary because the trusted checkpoint snapshot and governance validation model consume that semantic view.

The authenticated resume store crosses the install boundary through `installTrustedPortableResume()`. That function validates the original external tip/digest anchor through the streamed trust bridge and publishes the reconstructed canonical snapshot through `ChainStore.installTrustedSnapshot()`. The installer retains the existing staged-directory fsync, recovery re-open verification, no-overwrite check and atomic directory publication semantics. Disposable validation staging is removed on both success and failure, while the resumable transport store is left intact for the caller's poison/failover policy.

## Production fetch/install wiring

The supported `zyron-l1` executable still enters through `secure-cli`, so local `--genesis` input remains descriptor-bound, bounded and privately staged before parsing. For `state-fetch-install`, `secure-cli` now dispatches to the dedicated bounded production command rather than the legacy CLI implementation.

That command uses `fetchTrustedPortableResumeFromAnyPeer()` to download directly into `PortableStateResumeStore`. A completed store is authenticated through `validatePortableResumeSnapshot()` before it can be returned. If complete staged bytes fail the external tip hash, full-snapshot digest, State-v2 root, reachability, semantic-key or finalized-snapshot checks, the staged resume directory is discarded and classified as an assembly failure. The same peer receives one clean retry; after that, the bounded peer list is tried in order. Ordinary interrupted/network failures keep durable partial progress so another attempt or peer can resume it.

After the P2P client stops, the command passes the authenticated resume store to `installTrustedPortableResume()`. The resume directory is deleted only after the crash-safe install succeeds. No supported production `state-fetch-install` step calls `PortableStateResumeStore.bundle()`, constructs a full portable `records[]`/`keyPreimages[]` bundle, or performs the legacy second `structuredClone(bundle)`.

The legacy exported portable-state fetch APIs remain for compatibility/testing and still expose the bundle-shaped return type. They are not the supported production `zyron-l1 state-fetch-install` path. Removing or redesigning those compatibility APIs can be handled separately without weakening the production recovery boundary.

## Reproducible staging-memory measurement

The branch includes a dedicated benchmark that measures the bounded resume staging path in a separate worker process from fixture construction. This separation prevents source-state/bundle generation memory from being counted as staging memory.

```sh
cd l1
ZYRON_RESUME_SCALE_ACCOUNTS=10000 npm run bench:state-resume-scale
```

The benchmark reports the authenticated root, portable record/key counts, staging duration, heap delta, final RSS, and process peak RSS. `ZYRON_RESUME_SCALE_ACCOUNTS` accepts positive values up to 250,000 so larger engineering runs can be collected on reviewed target hardware without changing source. The benchmark verifies that staged counts and the authenticated State-v2 root exactly match the prepared fixture.

`Standalone L1 State-v2 Scale Evidence CI` runs the bounded resume benchmark at 10,000 accounts in its own job and archives the raw result, SHA-256 manifest, root/count identity checks, and memory measurements. That artifact is explicitly stamped `measurementsAreCiRegressionEvidenceOnly=true` and `targetHardwareGateClosed=false`; a green CI job therefore proves only that the benchmark executes and its authentication/count invariants hold on the GitHub runner. It cannot be cited as intended-deployment capacity evidence.

This benchmark is **engineering evidence tooling, not public-testnet/mainnet evidence by itself**. CI-scale or developer-laptop results must not close the target-hardware gate. Accepted readiness evidence still requires reviewed runs on the intended deployment class with the exact release commit and environment recorded.

The production wiring closes the code-level full-bundle materialization gap for the supported recovery command, but **does not by itself close issue #383 or any activation gate**. Final merge/closure still requires fixed-head green general ZyronChain CI plus Standalone L1 Node 22/24 and reviewed target-hardware peak-memory evidence. Public-testnet and mainnet activation gates remain unchanged.