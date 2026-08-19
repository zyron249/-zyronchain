# Signing-journal hard-crash regression boundary

Validator signing-journal writer exclusivity is a consensus-safety boundary. A live validator process must hold the single-writer lease, a conflicting live writer must be rejected, and a hard crash must release the lease without losing the already durable reserved signing choice.

The canonical hard-crash regression is `l1/test/signing-lease-crash.test.ts`. It uses an IPC probe to establish that the holder process is still live immediately before the concurrent-open assertion, then kills that exact process and verifies restart preserves the reserved choice while rejecting a conflicting choice.

The older process-racy duplicate that inferred holder liveness from stdout timing has been removed from `l1/test/l1.test.ts`. It intermittently produced false-negative CI results when the holder exited between the readiness message and the concurrent-open assertion. The full test runner now fails closed if that legacy title is reintroduced or if the deterministic IPC replacement disappears; it no longer relies on a test-name filter to hide the legacy test.

This change affects test reliability only. It does not weaken `SigningJournal` writer exclusivity, durable reservation semantics, fail-stop behavior, consensus/finality rules, validator custody requirements, or any public-testnet/mainnet/mining activation gate.
