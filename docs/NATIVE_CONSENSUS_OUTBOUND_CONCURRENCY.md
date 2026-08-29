# Native consensus outbound concurrency

Native attestation and round-skip collection is availability-sensitive because each eligible peer may require a dial, authenticated Noise stream, bounded frame write, and bounded response read. The configured native peer set remains capped at 64 peers, but cardinality alone is not a sufficient simultaneous-resource bound.

The native consensus client therefore schedules attestation and round-skip collection through an aggregate worker pool capped at 8 concurrent outbound operations. All configured eligible peers remain in the scheduling set; this does not change validator membership, proposer selection, quorum thresholds, skip-certificate chaining, signature validation, or anti-equivocation rules.

Each collection shares one 8-second wall-clock deadline. Network operations recalculate the remaining budget before bounded frame work, and the shared abort signal terminates cooperative dial/stream work at the collection deadline. The deadline is also a hard caller-visible return boundary: the collector does not continue waiting for an in-flight request promise that fails to settle after abort. A queue of slow or wedged peers therefore cannot convert one finality collection into a serial or indefinite wait.

At the deadline, already-started requests that remain unresolved are represented as rejected results and queued requests are not started. A late completion after the collector has returned cannot become finality evidence. Timeouts, aborted requests, malformed responses, and resource exhaustion produce no synthetic attestation or round-skip vote. Only fulfilled responses completed before the return boundary that also pass the existing response-shape, chain-identity, cryptographic, and quorum validation paths may contribute finality evidence.

Regression tests cover the aggregate active-operation ceiling, the shared-deadline behavior with abort-cooperative requests, and hard return-by-deadline behavior when a synthetic request never settles and ignores `AbortSignal`.

A hard collection return deadline does not claim synchronous destruction of an underlying third-party transport resource that ignores cancellation. Existing per-operation transport timeouts, byte budgets, Noise authentication, response-shape checks, and downstream quorum/finality validation remain mandatory.

This is RPC/P2P/finality availability hardening only. It is not evidence that public mining, public testnet, or mainnet activation gates are satisfied.