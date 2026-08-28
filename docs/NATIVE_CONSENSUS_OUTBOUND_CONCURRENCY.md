# Native consensus outbound concurrency

Native attestation and round-skip collection is availability-sensitive because each eligible peer may require a dial, authenticated Noise stream, bounded frame write, and bounded response read. The configured native peer set remains capped at 64 peers, but cardinality alone is not a sufficient simultaneous-resource bound.

The native consensus client therefore schedules attestation and round-skip collection through an aggregate worker pool capped at 8 concurrent outbound operations. All configured eligible peers remain in the scheduling set; this does not change validator membership, proposer selection, quorum thresholds, skip-certificate chaining, signature validation, or anti-equivocation rules.

Each collection shares one 8-second wall-clock deadline. Network operations recalculate the remaining budget before bounded frame work, and the shared abort signal terminates outstanding dial/stream work at the collection deadline. A queue of slow peers therefore cannot convert one finality collection into a serial N × 8-second wait.

Timeouts, aborted requests, malformed responses, and resource exhaustion produce no synthetic attestation or round-skip vote. Only fulfilled responses that also pass the existing response-shape, chain-identity, cryptographic, and quorum validation paths may contribute finality evidence.

Regression tests cover both the aggregate active-operation ceiling and the shared-deadline behavior while retaining a fast successful peer response alongside slow peers.

This is RPC/P2P/finality availability hardening only. It is not evidence that public mining, public testnet, or mainnet activation gates are satisfied.