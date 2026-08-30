# Consensus outstanding-work bounds

HTTP and native consensus collection use a process-wide, wait-free operation budget in addition to each collector's existing per-call concurrency and hard wall-clock return deadline.

- HTTP consensus starts at most 32 underlying peer operations process-wide.
- Native consensus collection starts at most 32 underlying peer operations process-wide.
- A permit is acquired before transport work starts and is released only when that underlying request promise actually settles. A caller-visible collection deadline does not release a permit for an abort-noncooperative operation.
- Saturation is fail-closed: the collector skips/rejects new peer work immediately rather than creating an unbounded waiter queue.
- Late completions remain excluded from a result snapshot returned after its collection deadline.

These limits bound accumulation caused by transports that ignore abort or never settle. They do not weaken authentication, response-size/parse budgets, quorum/finality validation, reputation controls, or activation gates.

This hardening is resource-DoS containment only. It is not evidence that public mining, public testnet, or mainnet activation is ready.
