# HTTP consensus outbound resource bounds

HTTP consensus collection is intentionally bounded independently of configured peer cardinality.

- A collection may have at most 8 outbound HTTP consensus operations active at once.
- All configured peers remain eligible; the worker pool changes scheduling only and does not shrink the validator or peer eligibility set.
- Attestation and round-skip collection use one shared 8-second wall-clock deadline. Slow peers therefore cannot turn the 64-peer configuration ceiling into serial `N × timeout` latency.
- When the shared deadline expires, in-flight requests are aborted and queued peers are not started. Deadline, network, parsing, authentication, or resource-budget failures contribute no synthetic attestation or skip vote.
- Existing per-route response byte ceilings, aggregate wire/parse budgets, RPC-version checks, peer-request authentication, canonical response-shape validation, and downstream quorum/finality validation remain mandatory.

These limits are defensive availability controls only. They are not evidence of public mining, public testnet, or mainnet readiness, and they do not weaken any activation or finality gate.
