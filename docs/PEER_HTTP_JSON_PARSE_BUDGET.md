# Peer HTTP JSON parse memory boundary

Configured-peer HTTP responses keep their existing per-response byte caps, timeout/RPC-version/content-type checks, peer diversity and reputation behavior, plus the 50 MiB global received-wire-byte budget.

JSON parsing now has a separate bounded global parse budget. Before contiguous Buffer and UTF-8 string allocation, the peer client reserves conservative transient capacity. A lexical pre-parse scan limits nesting to 64 levels and structural punctuation to 250,000 tokens. Punctuation inside strings and escaped quotes is ignored.

After parsing, a conservative decoded-graph allowance derived from twice the wire bytes plus bounded structural cardinality stays reserved through route-specific validation. Ordinary request paths release that allowance before returning the validated value. Finalized block-sync paths retain it beyond validation until the selected block batch is accepted or discarded; concurrent any-peer probes release every unselected successful candidate immediately. The transient allowance is released immediately after parsing, while wire reservations are released after parsing and decoded reservations follow the validated value ownership lifetime. This prevents configured malicious peers from turning size-valid compact JSON or concurrent retained block candidates into unbounded heap pressure.

These controls are DoS hardening only. They do not change consensus, finality, mining, reward, governance, public-testnet or mainnet activation semantics, and they are not evidence of deployment readiness.
