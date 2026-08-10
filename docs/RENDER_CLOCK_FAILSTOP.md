# Render validator clock fail-stop supervision

Status: private/adversarial rehearsal only. This does not authorize a public testnet or mainnet.

The canonical validator signer deliberately fails closed if its local wall clock moves backwards by more than the configured safety tolerance. A faulted `NodeService` reports `validator-clock-unhealthy` and will not sign again until process restart. This safety behavior must not be weakened to improve liveness.

The single-instance Render rehearsal places all four validator processes in one host/clock failure domain. Live evidence on 2026-08-10 showed one validator entering the clock fail-stop while the public gateway process remained alive and no finalized block was observed in the following log window. That is an operational liveness failure of this rehearsal profile, not evidence that the consensus clock guard should be relaxed.

`render-clock-failstop-supervisor.mjs` therefore supervises only the ephemeral Render rehearsal. It polls the local read-only readiness summary and, if any validator reports `validator-clock-unhealthy`, terminates the entire rehearsal with a non-zero fail-closed exit. It does not clear the signing journal, alter the 1-second rollback tolerance, reuse a different key, mint funds, or authorize launch. The Render service may then restart according to platform policy; because this profile is intentionally ephemeral, a full process restart may create a new testnet genesis.

Production and sustained public-testnet operation require a different recovery model: independent validator hosts and clock failure domains, persistent data, production signer custody, explicit operator/orchestrator restart policy, and preserved anti-equivocation journals. This Render supervisor is not evidence for those external gates.
