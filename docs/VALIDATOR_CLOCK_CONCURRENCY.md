# Validator signing clock versus consensus timestamp

Status: pre-public-testnet security regression evidence.

`produceFinalizedBlock()` chooses one consensus timestamp for the production attempt. That timestamp determines the candidate round and is committed into the block header. It must remain stable while peer skip/attestation I/O is in flight.

The validator anti-rollback clock is a different safety boundary. A local signing request that happens after asynchronous peer work must sample the current local wall clock rather than reuse the older consensus timestamp captured before the wait. Otherwise a legitimate concurrent signing request can advance the same `NodeService` clock watermark and make the producer's older timestamp look like a host clock rollback.

The producer therefore refreshes the local signing-clock sample at each local signing boundary while keeping the block/round timestamp fixed. Direct `NodeService` signing methods still accept explicit `nowMs` values so deterministic tests can prove that a genuine rollback beyond the one-second tolerance remains fail-closed until process restart.

`validator-clock-concurrency.test.ts` reproduces the concurrency ordering: peer work advances the validator clock watermark while production is awaiting a round-skip response, then production must complete without `validator-clock-unhealthy` and without changing the original block timestamp. A second regression confirms a true explicit rollback still triggers the original fail-stop behavior.

This does not relax `MAX_VALIDATOR_CLOCK_ROLLBACK_MS`, quorum, signing-journal reservations, or any consensus rule.
