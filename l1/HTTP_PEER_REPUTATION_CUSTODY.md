# HTTP Peer-Reputation Persistence Custody

The durable HTTP peer-reputation snapshot is treated as bounded local security state, not as trusted parser input or a disposable cache.

- Snapshot reads remain capped at 2 MiB by the shared bounded-file custody layer before any JSON materialization.
- Before `JSON.parse()`, structural complexity is bounded to 16 levels of object/array nesting and 8,192 structural tokens. Punctuation inside quoted or escaped JSON strings is ignored by the structural preflight.
- The canonical snapshot schema remains exact and shallow: version 1, at most 256 normalized HTTP(S) peer endpoints, bounded counters, and no duplicate endpoints.
- Identity capacity is fail-closed. Once 256 endpoints are tracked, an unknown endpoint is unavailable and its success/failure events cannot evict or replace any tracked endpoint, including entries whose current backoff has expired. Existing tracked endpoints continue to update normally.
- This no-eviction rule survives restart because the same bounded snapshot is restored without admission-side reclamation.
- Persistence durability remains temporary-file write + file fsync + atomic rename + directory fsync where supported.
- These controls do not change consensus/finality rules, authentication, activation gates, or readiness claims.

The parser bounds and no-eviction capacity rule reduce malformed-state amplification and attacker-driven reputation-history churn. They are defense-in-depth and are not evidence of public-testnet or mainnet readiness.
