# Render validator clock fail-stop supervision

Status: private/adversarial rehearsal only. This does not authorize a public testnet or mainnet.

The canonical validator signer deliberately fails closed if its local wall clock moves backwards by more than the configured safety tolerance. A faulted `NodeService` reports `validator-clock-unhealthy` and will not sign again until process restart. This safety behavior must not be weakened to improve liveness.

The single-instance Render rehearsal places all four validator processes in one host/clock failure domain. Live evidence on 2026-08-10 showed one validator entering the clock fail-stop while the public gateway process remained alive and no finalized block was observed in the following log window. That is an operational liveness failure of this rehearsal profile, not evidence that the consensus clock guard should be relaxed.

The Render service's existing start command remains `node scripts/render-private-testnet.mjs`. That stable entrypoint now loads the preserved four-validator/gateway implementation from `render-private-testnet-base.mjs` in the same Node process and starts a same-process readiness monitor. This activates fail-closed supervision without changing the Render dashboard start command and without adding another long-lived Node process.

The monitor polls only loopback `/readyz`. If any validator reports `validator-clock-unhealthy`, it marks the rehearsal for non-zero exit and sends SIGTERM to the current process. The base launcher owns graceful shutdown of the gateway and validator children; a `beforeExit` guard restores exit code 70 after graceful cleanup. The monitor does not clear the signing journal, alter the rollback tolerance, reuse a different key, mint funds, or authorize launch. Because this profile is intentionally ephemeral, a platform restart may create a new testnet genesis.

The memory rehearsal remains the same five-process topology: one gateway/entrypoint process plus four validators. The existing aggregate PSS hard ceiling and post-warmup growth budget are unchanged.

`render-clock-failstop-supervisor.mjs` remains as a standalone rehearsal tool and CI harness. It may launch the stable entrypoint in a separate process to verify supervisor behavior, but the live Render start path uses the same-process monitor to avoid a permanent extra memory cost.

Production and sustained public-testnet operation require a different recovery model: independent validator hosts and clock failure domains, persistent data, production signer custody, explicit operator/orchestrator restart policy, and preserved anti-equivocation journals. This Render monitor is not evidence for those external gates.
