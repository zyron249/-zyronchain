# ZyronChain State-v2 scale regression evidence

Status: **CI regression evidence only**. This does not close the release/target-hardware scale gate and does not authorize a public testnet or mainnet.

`l1/bench/state-v2-scale.ts` already exercises authenticated State-v2 persistence at configurable cardinality. `Standalone L1 State-v2 Scale Evidence CI` makes a 100,000-account run required and archives its machine-readable result.

The run:

1. creates 100,000 semantic account records in bounded batches;
2. churns up to 1,000 existing accounts so historical objects exist;
3. reopens the disk-backed store and requires the authenticated root to remain identical;
4. requires the resolver's resident record cache to remain at or below 4,096 entries;
5. garbage-collects historical State-v2 objects and requires at least one historical node to be removed without changing the authenticated root;
6. reopens again after GC and requires the same root and cache bound;
7. records setup/restart/GC durations, restart RSS/heap delta, node/key counts and SQLite bytes;
8. wraps the successful result with exact commit/run/job/runtime metadata and SHA-256 checksums for 90-day artifact retention.

The first required CI version deliberately sets **no absolute timing or RSS pass threshold** beyond structural safety/cache invariants. GitHub-hosted runner performance is not a stable proxy for target deployment hardware. Repeated evidence should be reviewed before introducing a regression budget.

The mainnet/release gate in `STANDALONE_L1_READINESS.md` remains open: large-cardinality restart/GC/capacity measurements must still be repeated on explicitly selected release hardware under representative storage, filesystem and operational conditions.
