# ZyronChain Render private testnet profile

Status: non-value-bearing private/adversarial infrastructure rehearsal only. This profile does not authorize a public testnet or mainnet.

## Current profile

The Render private-testnet launcher runs four canonical `zyron-l1 node` validator processes inside one Render service. Validator RPC listeners remain loopback-only. A separate read-only HTTP gateway exposes status/health information on Render's public `PORT` and explicitly reports `valueBearing=false`, `publicTestnetAuthorized=false`, and `mainnetAuthorized=false`.

The gateway is hardened with request-target validation, internal-RPC redaction, coalesced status aggregation, bounded active requests, explicit connection/header/request-per-socket limits, an absolute incomplete-header deadline, request/keep-alive timeouts, and a 16 KiB header ceiling. Separate smoke, large-burst and raw-socket red-team workflows exercise these boundaries.

## Memory evidence

The four-validator launcher intentionally uses several Node.js processes. Summing per-process RSS is not an appropriate physical-memory estimate because shared executable/library/file-backed pages are counted once in every process RSS. On Linux CI, `render-memory-soak.mjs` therefore reads `/proc/<pid>/smaps_rollup` and aggregates **PSS (Proportional Set Size)** across the gateway plus four validators. PSS proportionally charges shared pages and is materially closer to the process group's physical-memory pressure. Summed RSS is retained in evidence only for diagnostics.

The memory soak waits for organic finality, samples the five-process tree through finalized height 6, requires all validators to remain alive/converged, enforces a 430 MiB aggregate-PSS hard ceiling and less than 128 MiB post-warmup PSS growth. These are conservative engineering gates for the current 512 MiB Render profile, not production capacity guarantees.

Render's own service-level memory metric remains authoritative for the live deployment because it reflects the platform/cgroup accounting used for enforcement. CI PSS and live Render metrics should be compared directionally rather than treated as byte-identical measurements.

## Remaining limits

This is still one provider, one service instance and one infrastructure failure domain. Runtime-generated test keys and the default filesystem are ephemeral; redeploy/restart intentionally creates a new private-testnet genesis unless a separately reviewed durable profile is introduced. This profile does not prove independent operators, multi-cloud or multi-jurisdiction failure domains, production HSM custody, public validator admission, sustained Internet P2P behavior, mainnet economics or immutable mainnet genesis.
