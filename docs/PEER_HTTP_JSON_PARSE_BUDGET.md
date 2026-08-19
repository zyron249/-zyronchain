# Peer HTTP JSON parse memory boundary

Configured-peer HTTP responses keep their existing per-response byte caps, timeout/RPC-version/content-type checks, peer diversity and reputation behavior, plus the 50 MiB global received-wire-byte budget.

JSON parsing now has a separate bounded global parse budget. Before contiguous Buffer and UTF-8 string allocation, the peer client reserves conservative transient capacity. A lexical pre-parse scan limits nesting to 64 levels and structural punctuation to 250,000 tokens. Punctuation inside strings and escaped quotes is ignored.

After parsing, a decoded-graph allowance derived from wire bytes plus bounded structural cardinality stays reserved through the route-specific validation callback. The transient allowance is released immediately after parsing, while wire and decoded reservations are released after validation or on every failure path. This prevents configured malicious peers from turning size-valid compact JSON into unbounded parse-time heap pressure.

These controls are DoS hardening only. They do not change consensus, finality, mining, reward, governance, public-testnet or mainnet activation semantics, and they are not evidence of deployment readiness.
