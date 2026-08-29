# HTTP consensus outbound resource bounds

HTTP consensus collection is intentionally bounded independently of configured peer cardinality.

- A collection may have at most 8 outbound HTTP consensus operations active at once.
- All configured peers remain eligible; the worker pool changes scheduling only and does not shrink the validator or peer eligibility set.
- Attestation and round-skip collection use one shared 8-second wall-clock deadline. Slow peers therefore cannot turn the 64-peer configuration ceiling into serial `N × timeout` latency.
- The shared deadline is a hard caller-visible return deadline, not merely an `AbortSignal` request. When it expires the collector aborts the shared signal, stops scheduling queued peers, and stops waiting for any in-flight request promise that fails to cooperate with cancellation.
- Results are snapshotted at return time. A request that completes only after the deadline cannot mutate or contribute to the returned attestation/skip-vote set.
- Deadline, network, parsing, authentication, or resource-budget failures contribute no synthetic attestation or skip vote.
- Existing per-route response byte ceilings, aggregate wire/parse budgets, RPC-version checks, peer-request authentication, canonical response-shape validation, and downstream quorum/finality validation remain mandatory.

A hard collection return deadline does not claim that an underlying operating-system or transport resource disappears synchronously when a third-party operation ignores cancellation. The transport still receives the abort signal and retains its own operation bounds; the consensus caller is no longer held hostage waiting for a non-cooperative promise to settle.

These limits are defensive availability controls only. They are not evidence of public mining, public testnet, or mainnet readiness, and they do not weaken any activation or finality gate.
