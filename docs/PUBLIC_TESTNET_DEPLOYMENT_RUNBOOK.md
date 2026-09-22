# Public testnet deployment runbook

Status: **not launched**. This runbook describes how operators would deploy a public testnet after governance supplies real values. It does not supply those values. `publicTestnetActivationAllowed`, `mainnetActivationAllowed`, `publicMiningActivated`, and `publicationAllowed` stay false. No chain ID, genesis file, bootstrap peer, public RPC origin, or hosting address in this repository is a live deployment.

Regions in this document are the abstract names `region-a`, `region-b`, and `region-c`. They are not AWS, GCP, Render, or any other provider, and they are not IP addresses or DNS names.

## Roles

| Role | Count | Region | Public exposure |
|---|---|---|---|
| Validator A, B, C | 3 | one per region | Consensus RPC and P2P only on the private validator network |
| Bootstrap A, B, C | 3 | one per region | P2P multiaddr published by governance. Not a consensus RPC |
| Public RPC A, B | 2 | two regions | HTTPS only. Public role. Consensus paths refused |
| Archive | 1 | a region that is not the only copy of the chain | No consensus signing |
| Monitoring | 1 | separate from the public RPC proxies | Private path to metrics |

A later operator document may map these roles onto real providers. This file must not be edited to invent that map.

## Per-node baseline

Every role uses the same minimum host shape:

- CPU: 2 cores
- RAM: 4 GB
- Disk: 100 GB persistent disk
- OS: Linux
- Node.js: 22 or newer
- Process user: unprivileged, dedicated
- Data: one data directory per node, holding the chain database and, for validators, the signing journal
- Backup: stop the process or take a crash-consistent snapshot of that whole directory. Do not delete or hand-edit the signing journal
- Restart: start the same binary against the same genesis file and data directory
- Health: `GET /healthz` and `GET /readyz` on the role that serves them, plus a check that finalized height moves

Ports:

- Public RPC: TCP 443 on the reverse proxy, forwarding only to the public role
- Validator consensus HTTP and P2P: operator-assigned private ports, not published in DNS for miners
- Metrics: reachable from the monitoring role only

## Prerequisites

1. A reviewed release artifact of `l1/`. This runbook does not attach provenance and does not claim a release is ready.
2. Governance input that passes `parsePublicTestnetGovernanceInput` with status `governance-approved`.
3. Three validator public keys, one activity-oracle public key, an activity-pool address, and explicit allocations. No private keys in git. No founder, premine, or team allocation purpose.
4. Three bootstrap records, each with an operator-supplied peer ID, multiaddr, and failure domain. The three failure domains must differ. The same domain three times is an error. The same domain twice is a warning.
5. Two public HTTPS RPC origins, plus archive and monitoring HTTPS origins.
6. Launch authorization still reviewed separately. Authorization is not activation.

The checked-in example `l1/config/public-testnet-governance-input.example.json` is schema-valid and unfilled. The genesis builder rejects it.

## Governance inputs

Required human inputs, which this repository does not invent:

- network name
- chain ID of the form `zyron-public-testnet-<label>`
- genesis timestamp chosen by governance, never the builder's wall clock
- genesis validator public keys
- real bootstrap identities
- public HTTPS RPC domains
- hosting regions and providers
- activation authorization

`initialProtocolVersion` must be 1. Protocol v5 stays `quorum-delayed-upgrade`: a later quorum and the existing protocol delay. Validator `weight` must be 1. Other weights are rejected because consensus has no weight field.

## Genesis

From a directory that contains the built `l1/dist` tree:

```bash
cd l1
npm run build
node scripts/build-public-testnet-genesis.mjs --config <governance-approved-testnet.json> --out <empty-directory>
```

The script fails closed when `--config` is missing, when the file is the example, when the chain ID is null, or when a timestamp, validator, or endpoint is missing or placeholder. It does not default a chain ID from the clock, a random source, a hostname, or a path.

Given the same file, two hosts write the same `genesis.json` bytes. The report next to it contains the genesis file SHA-256, the canonical genesis block hash, the chain ID, the validator-set hash, and the configuration hash.

Do not copy that output into `l1/config/public-testnet-identity.json` until governance freezes it. Today that identity file keeps `chainId` and `genesisHash` null.

## Deploy each role

Startup order:

1. Archive and monitoring, so they can observe from the first block.
2. Bootstrap A, B, and C.
3. Validator A, B, and C, each with its own key on the validator machine.
4. Public RPC A and B, public role only, behind TLS.

Validators use the frozen genesis file and a private bind. They do not use the public RPC role. Public RPC processes set `rpcRole` to `public` and do not load validator signing keys.

## Firewall

| Source | Destination | Decision |
|---|---|---|
| Internet | Public RPC | Allow HTTPS |
| Internet | Validator consensus | Deny |
| Internet | Bootstrap P2P | Allow the published multiaddr only |
| Validators | Validators | Allow consensus and P2P |
| Bootstraps | Peers | Allow P2P |
| Monitoring | Metrics | Allow on the private monitoring path |
| Miners | Public RPC | Allow HTTPS |
| Miners | Validator consensus | Deny |
| Public reverse proxy | Consensus routes | Deny |

The public role returns 403 for `/proposal/attest`, `/round/skip`, `/round/lock`, `/round/report`, `/round/complete`, and `/block`. Spoofed `X-Forwarded-For` does not change that. A rate-limit identity uses `X-Forwarded-For` only when the TCP peer is a configured trusted proxy. Other clients are limited by their own TCP address.

## TLS and public RPC environment

Terminate TLS on the reverse proxy. The proxy sets `X-Forwarded-Proto: https`. Pass only that proxy address to `--rpc-trusted-proxy`.

Environment names, all required and all empty in `l1/config/public-rpc-deployment.env.example`:

- `ZYRON_PUBLIC_RPC_ORIGIN`
- `ZYRON_PUBLIC_RPC_BIND`
- `ZYRON_PUBLIC_RPC_RATE_LIMIT`
- `ZYRON_PUBLIC_RPC_MAX_BODY`
- `ZYRON_PUBLIC_RPC_TIMEOUT_MS`
- `ZYRON_PUBLIC_RPC_TRUSTED_PROXY`

`admitPublicRpcDeploymentEnv` does not admit a listener. Missing values, `PLACEHOLDER`, `CHANGEME`, `example.com`, `localhost`, and `127.0.0.1` are rejected. The checked-in process does not read these variables.

## Bootstrap wiring

Each bootstrap entry needs `peerId`, `multiaddr`, and `failureDomain` from the operator. Public deployment preflight fails when fewer than three bootstraps are present, when a peer ID repeats, or when one failure domain is used three times. A handshake with the wrong chain ID or genesis hash is still rejected with `P2P chain identity mismatch`.

The checked-in `l1/config/public-testnet-bootstrap.json` slots remain `PLACEHOLDER` and are not dial targets.

## Health, consensus, and mining checks

After a future authorized start, operators check:

- both public RPC origins answer `/healthz`
- validator finalized heights match
- one height has one finalized hash
- peer count is at least the live bootstrap set
- mining claims that do finalize use the unchanged schedule: 6.25 ZYN, halving every 4,000,000 claims, 20-bit target, 50,000,000 ZYN cap

This runbook does not start mining publication.

## Backup, restore, restart, replacement

- Backup the data directory after a clean shutdown, or with a snapshot that includes the database and the signing journal together.
- Restore onto a new disk, then start the same genesis file. Do not generate a second genesis.
- Restart is the same command line. A validator that restarts keeps its journal and must not be given a second private key for the same slot.
- Replacing a validator is a later quorum validator-set update, not an edit of a running journal.
- Rollback of a bad release is: stop the new binary, start the previous reviewed binary on the same data directory. Do not delete journals to force a different vote.

## Incident, shutdown, evidence

Stop the affected role, keep its data directory, and record height, tip hash, and whether any other node shows a different hash at that height. A divergent finalized hash is a critical failure. Shutdown of the whole network is the reverse of startup: public RPC, validators, bootstraps, then observers. Leave genesis and journals intact.

`npm run public-testnet:preflight` prints engineering readiness and governance activation. On this repository the expected pair is engineering `PASS` and governance `BLOCKED` / `NOT READY FOR ACTIVATION`.

## Soak evidence

The harness accepts durations `24h`, `72h`, and `7d`. It does not invent a soak.

```bash
node scripts/public-testnet-soak-evidence.mjs --duration 24h --evidence <samples.json-or-csv>
```

Samples must show finalized height advancing. Two different tip hashes at one height fail the run. Process uptime alone is not progress.

## Failure drills

Controlled expectations, without a destructive default:

| Drill | Expected consensus behavior |
|---|---|
| Bootstrap A and B down | Bootstrap C remains a dial path. Finality continues if a validator quorum is reachable |
| One validator down, then up | The other validators keep quorum. The returned validator syncs to their hash |
| Public RPC A down | Miners use public RPC B. Consensus ports stay closed |
| Miner disconnect and reconnect | Submissions pause, then follow the current tip. Stale claims do not become canonical |
| Validator or archive restart | Reload durable state. The tip hash matches the quorum |
| Latency or loss | Rounds may skip. Finalized hashes stay unique |
| One region outage | The other two regions continue when they still hold a quorum |
| Disk pressure | The affected node fail-stops. It must not serve a second tip |
| Crash recovery | Restart resumes the last durable block and journal reservation |
| Fresh sync | The new node reaches the same tip hash |
| Checkpoint sync | Install still requires the out-of-band tip hash and snapshot digest |
| Catch-up | The lagged validator applies the finalized sequence in order |

Any drill that observes two finalized hashes at one height is a critical failure.

## Multi-miner preparation

Cohorts of 3, 10, 25, and 50 miners are the planned sizes. Each miner uses a separate wallet on the miner machine. The accounting check compares accepted finalized rewards with the issuance schedule and rejects a total above the 50,000,000 ZYN cap. Rejected, stale, and duplicate claims do not issue. This preparation does not set `publicMiningActivated`.

## Observability

The proposed series, not yet emitted as a live scrape contract, are:

`zyron_finalized_height`, `zyron_finality_latency_ms`, `zyron_peer_count`, `zyron_rpc_requests`, `zyron_rpc_errors`, `zyron_rpc_latency_ms`, `zyron_validator_up`, `zyron_validator_signing_failures`, `zyron_mining_claims_accepted`, `zyron_mining_claims_rejected`, `zyron_mining_claims_stale`, `zyron_state_bytes`, `zyron_db_bytes`, `zyron_process_rss_bytes`, `zyron_process_uptime_seconds`.

Critical conditions: stalled finality, divergent finalized hash, quorum loss, genesis or chain ID mismatch, signing-failure burst, state corruption, public RPC total outage, all bootstraps down, reward or supply invariant violation.

## What remains human work

Do not fill these from this document:

- network name
- chain ID
- genesis validator public keys
- real bootstrap identities
- public HTTPS RPC domains
- hosting regions and providers
- activation authorization
