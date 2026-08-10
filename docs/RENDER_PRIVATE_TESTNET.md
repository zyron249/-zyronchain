# ZyronChain Render private testnet profile

Status: non-value-bearing private/adversarial infrastructure rehearsal only. This profile does not authorize a public testnet or mainnet.

## Current profile

The Render private-testnet launcher runs four canonical `zyron-l1 node` validator processes inside one Render service. Validator RPC listeners remain loopback-only. A separate read-only HTTP gateway exposes status/health information on Render's public `PORT` and explicitly reports `valueBearing=false`, `publicTestnetAuthorized=false`, and `mainnetAuthorized=false`.

The gateway is hardened with request-target validation, internal-RPC redaction, coalesced status aggregation, bounded active requests, explicit connection/header/request-per-socket limits, an absolute incomplete-header deadline, request/keep-alive timeouts, and a 16 KiB header ceiling. Separate smoke, large-burst and raw-socket red-team workflows exercise these boundaries.

## Memory evidence

The four-validator launcher intentionally uses several Node.js processes. Summing per-process RSS is not an appropriate physical-memory estimate because shared executable/library/file-backed pages are counted once in every process RSS. On Linux CI, `render-memory-soak.mjs` therefore reads `/proc/<pid>/smaps_rollup` and aggregates **PSS (Proportional Set Size)** across the gateway plus four validators. Summed RSS is retained in evidence only for diagnostics.

CI PSS is used as a **growth detector**, not as a byte-for-byte substitute for Render's cgroup accounting. The calibrated soak waits through warm-up to finalized height 4, then samples every finalized height through height 12. It requires the exact five-process topology, all validators alive/converged, and less than 96 MiB of peak aggregate-PSS growth above the warm-up sample. A large startup PSS value by itself does not fail this cross-environment CI gate because GitHub-hosted process accounting and Render cgroup charging are not identical.

Render's own service-level memory metric is the authoritative absolute-limit signal for the live deployment. The current free service limit is 512 MiB. Operationally, treat 80% sustained usage as a warning and 90% sustained usage as a stop-ship condition for this four-validator profile; investigate or move the rehearsal to a larger reviewed instance before relying on OOM behavior. The bounded CI growth test does not replace a multi-hour live soak or target-hardware State-v2 capacity measurements.

## Remaining limits

This is still one provider, one service instance and one infrastructure failure domain. Runtime-generated test keys and the default filesystem are ephemeral; redeploy/restart intentionally creates a new private-testnet genesis unless a separately reviewed durable profile is introduced. This profile does not prove independent operators, multi-cloud or multi-jurisdiction failure domains, production HSM custody, public validator admission, sustained Internet P2P behavior, mainnet economics or immutable mainnet genesis.
