# Render memory-soak action custody

The Render memory-soak workflow is regression evidence only. It does not satisfy the target-hardware peak-memory evidence required by issue #383 and must not be used to claim public-testnet or mainnet readiness.

The workflow must use reviewed immutable action SHAs, disable checkout credential persistence, preserve Node 24 locked install/build, measure post-warmup process-tree PSS growth through finalized height 12, and archive commit/run-attempt-bound evidence with fail-on-missing upload and 90-day retention.
