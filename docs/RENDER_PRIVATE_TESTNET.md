# ZyronChain Render private testnet profile

Status: non-value-bearing private/adversarial infrastructure rehearsal only. This profile does not authorize a public testnet or mainnet.

## Current profile

The Render private-testnet launcher runs four canonical `zyron-l1 node` validator processes inside one Render service. Validator RPC listeners remain loopback-only. A separate read-only HTTP gateway exposes status/health information on Render's public `PORT` and explicitly reports `valueBearing=false`, `publicTestnetAuthorized=false`, and `mainnetAuthorized=false`.

The gateway is hardened with request-target validation, internal-RPC redaction, coalesced status aggregation, bounded active requests, explicit connection/header/request-per-socket limits, an absolute incomplete-header deadline, request/keep-alive timeouts, and a 16 KiB header ceiling. Separate smoke, large-burst and raw-socket red-team workflows exercise these boundaries.

## Render Free Web Service boundary: smoke-only

The connected rehearsal currently uses a **Render Free Web Service**. It is therefore a **smoke-only / bounded-adversarial** hosting profile, not an always-on blockchain host.

Long-window live observation confirmed platform-driven shutdown behavior rather than a validator clock fault: the network finalized through height 27 and then received SIGTERM at `2026-08-10T14:05:16Z`; after a later cold start it finalized through height 16 and received another SIGTERM at `2026-08-10T16:42:16Z`. In both cases validators drained cleanly. This evidence must not be cited as sustained testnet uptime, multi-hour live soak, independent-operator availability or production infrastructure.

**Do not add artificial keepalive/self-ping traffic** to disguise the hosting limitation. A blockchain rehearsal that claims sustained uptime must run on explicitly approved **always-on compute** and must archive duration-based finality, memory, restart and incident evidence. Choosing a paid/always-on hosting plan is an infrastructure/cost decision and remains outside this Free-profile CI claim.

`docs/l1-render-hosting-profile.json` and `l1/scripts/verify-render-hosting-profile.mjs` fail closed if the Free profile is relabeled as sustained evidence or if the keepalive prohibition is removed.

## Memory evidence

The four-validator launcher intentionally uses several Node.js processes. Summing per-process RSS is not an appropriate physical-memory estimate because shared executable/library/file-backed pages are counted once in every process RSS. On Linux CI, `render-memory-soak.mjs` therefore reads `/proc/<pid>/smaps_rollup` and aggregates **PSS (Proportional Set Size)** across the gateway plus four validators. Summed RSS is retained in evidence only for diagnostics.

CI PSS is used as a **growth detector**, not as a byte-for-byte substitute for Render's cgroup accounting. The calibrated soak waits through warm-up to finalized height 4, then samples the exact five-process tree through height 12. It requires all validators to remain alive/converged and fails if peak aggregate PSS grows by 96 MiB or more above the warm-up sample. A large startup PSS value by itself does not fail this cross-environment CI gate because GitHub-hosted process accounting and Render cgroup charging are not identical.

Render's own service-level memory metric is the authoritative absolute-limit signal for the live deployment. The current free service limit is 512 MiB. Treat sustained 80% usage as a warning and sustained 90% usage as a stop-ship condition for this four-validator profile. Investigate or move the rehearsal to a larger reviewed instance before relying on OOM behavior. The bounded CI growth test does not replace a multi-hour live soak or target-hardware State-v2 capacity measurements.

## Remaining limits

This is still one provider, one service instance and one infrastructure failure domain. Runtime-generated test keys and the default filesystem are ephemeral across redeploys; the supervised recovery path may reuse material within the same live instance, but that does not make this a production persistent-storage profile. This profile does not prove sustained testnet uptime, independent operators, multi-cloud or multi-jurisdiction failure domains, production HSM custody, public validator admission, sustained Internet P2P behavior, mainnet economics or immutable mainnet genesis.
