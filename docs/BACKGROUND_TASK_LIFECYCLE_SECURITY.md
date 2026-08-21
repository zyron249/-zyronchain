# Background task lifecycle security

Periodic node work is admitted through `BackgroundTaskTracker`, which now enforces a fixed default maximum of 32 concurrently pending tasks. Once the tracker reaches that bound it rejects new work before invoking the supplied operation. Existing tasks are never evicted or cancelled merely to admit a newer periodic tick.

This limit bounds promise/resource retention when validator production, HTTP peer sync, discovery, or another scheduled operation is delayed by slow or adversarial I/O. Normal node scheduling is expected to remain far below the default cap; saturation is treated as an availability-pressure condition and new background work fails closed until existing tasks settle.

Shutdown semantics are unchanged. `drain()` first stops new admission and then waits for every task that was actually admitted, including rejected promises, to settle. Settled tasks reclaim capacity during normal operation.

This is lifecycle and availability hardening only. It does not alter consensus or finality rules, validator signing safety, peer authentication, mining/reward rules, launch authorization, or public-testnet/mainnet readiness gates. Repository CI evidence for this control is not external readiness evidence.