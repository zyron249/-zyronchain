# HTTP Peer-Reputation Persistence Custody

The durable HTTP peer-reputation snapshot is treated as bounded local state, not as trusted parser input.

- Snapshot reads remain capped at 2 MiB by the shared bounded-file custody layer before any JSON materialization.
- Before `JSON.parse()`, structural complexity is bounded to 16 levels of object/array nesting and 8,192 structural tokens. Punctuation inside quoted or escaped JSON strings is ignored by the structural preflight.
- The canonical snapshot schema remains exact and shallow: version 1, at most 256 normalized HTTP(S) peer endpoints, bounded counters, and no duplicate endpoints.
- Persistence durability remains temporary-file write + file fsync + atomic rename + directory fsync where supported.
- The new parser bound does not change peer backoff/reclamation behavior, consensus/finality rules, activation gates, or readiness claims.

These controls reduce parser/object-graph amplification from a malformed local snapshot. They are defense-in-depth and are not evidence of public-testnet or mainnet readiness.
