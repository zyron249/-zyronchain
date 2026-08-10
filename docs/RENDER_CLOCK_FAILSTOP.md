# Render validator clock fail-stop supervision

Status: private/adversarial rehearsal only. This does not authorize a public testnet or mainnet.

The canonical validator signer deliberately fails closed if its local wall clock moves backwards by more than the configured safety tolerance. A faulted `NodeService` reports `validator-clock-unhealthy` and will not sign again until process restart. This safety behavior must not be weakened to improve liveness.

The single-instance Render rehearsal places all four validator processes in one host/clock failure domain. Live evidence on 2026-08-10 showed one validator entering the clock fail-stop while the public gateway process remained alive and no finalized block was observed in the following log window. That is an operational liveness failure of this rehearsal profile, not evidence that the consensus clock guard should be relaxed.

The Render service's existing start command remains `node scripts/render-private-testnet.mjs`. That stable entrypoint now delegates to `render-clock-failstop-supervisor.mjs`, while the preserved canonical four-validator launcher lives in `render-private-testnet-base.mjs`. This makes supervision active without requiring a mutable Render dashboard/start-command change.

The supervisor polls only the local read-only readiness summary. If any validator reports `validator-clock-unhealthy`, it terminates the entire rehearsal with a non-zero fail-closed exit. It does not clear the signing journal, alter the rollback tolerance, reuse a different key, mint funds, or authorize launch. The Render service may then restart according to platform policy; because this profile is intentionally ephemeral, a full process restart may create a new testnet genesis.

The memory rehearsal treats the deployed topology as six processes: supervisor, gateway/base launcher, and four validator children. The existing aggregate PSS hard ceiling and post-warmup growth budget are not relaxed merely because supervision adds a process.

Production and sustained public-testnet operation require a different recovery model: independent validator hosts and clock failure domains, persistent data, production signer custody, explicit operator/orchestrator restart policy, and preserved anti-equivocation journals. This Render supervisor is not evidence for those external gates.
