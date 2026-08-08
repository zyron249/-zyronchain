# ZyronChain standalone Layer 1

This directory contains the standalone TypeScript Layer-1 implementation. It is intentionally separate from the historical Python/Flask `zyron-testnet-1` node so the existing testnet remains recoverable while the new consensus core matures.

## What exists now

- deterministic account state with exact integer atom balances and nonces;
- secp256k1 signed transfers and signed Proof-of-Activity settlement batches;
- SHA-256 transaction/block IDs, transaction Merkle roots, and deterministic state roots;
- genesis-pinned chain identity and a hard 50,000,000 ZYN supply ceiling;
- round-robin PoA proposals, strictly-greater-than-2/3 validator attestations, and certified proposer-failure view changes;
- append-only finalized block storage, replay-on-startup validation, and a persistent anti-double-sign journal;
- bounded mempool with nonce conflict protection and state-aware block selection;
- bounded JSON RPC with rate limits, health/metrics, optional consensus-write authentication, status, blocks, balances, nonces, transaction submission, proposal attestation, and finalized-block acceptance;
- static-peer identity handshake and incremental finalized-block synchronization;
- concurrent any-peer catch-up that rejects wrong-chain/invalid candidates before choosing a sync source;
- on-chain validator-set rotation authorized by the active set's >2/3 quorum with a 100-block activation delay;
- on-chain protocol-version upgrade and rollback scheduling authorized by >2/3 active-validator quorum with a 100-block activation delay and fail-stop behavior on unsupported versions;
- CLI key generation, genesis creation, node execution, and signed transfer submission.

One ZYN is `100,000,000` atoms. Transaction fees are currently burned: the sender is debited `amount + fee`, the receiver is credited `amount`, and no new balance is created. Proof-of-Activity settlement cannot mint supply; it may only distribute atoms already allocated to the configured activity pool.

Validator-set changes are protocol transactions, not single-admin actions. The initiating active validator consumes its account nonce, the update requires a strictly-greater-than-2/3 approval quorum from the current set, and activation must be at least 100 blocks in the future. Finalized history therefore reconstructs the same validator schedule on replay.

## Build and verify

Requires Node.js 22 or newer.

```sh
npm ci
npm run typecheck
npm test
npm audit --omit=dev
```

## Private devnet quick start

Generate one key file for each validator and another for the activity oracle. Key files contain private keys and are created mode `0600`.

```sh
npm run build
node dist/src/cli.js keygen --out validator-a.json
node dist/src/cli.js keygen --out validator-b.json
node dist/src/cli.js keygen --out oracle.json
```

Create a genesis file using the printed public keys and addresses. The activity pool must be an address included in the allocations if activity rewards are intended. Repeat `--validator-public-key`, `--oracle-public-key`, and `--allocation` as needed.

```sh
node dist/src/cli.js genesis \
  --out genesis.json \
  --chain-id zyron-devnet-1 \
  --validator-public-key <validator-a-public-key> \
  --validator-public-key <validator-b-public-key> \
  --oracle-public-key <oracle-public-key> \
  --activity-pool <pool-address> \
  --allocation <funded-address:atoms> \
  --allocation <pool-address:atoms>
```

Start validator nodes with distinct data directories and ports. Static peers are deliberate: public, unauthenticated peer admission is not used as a shortcut for mainnet discovery.

The preferred new node-to-node data plane is native TCP/libp2p with Noise and yamux. Enable a
listener explicitly with `--p2p-listen /ip4/0.0.0.0/tcp/9140` and configure outbound peers
with repeated `--p2p-peer` multiaddrs. Outbound peer addresses **must pin the expected PeerId**,
for example `/dns4/node-b.example/tcp/9140/p2p/<PeerId>`; an unpinned TCP endpoint is rejected.
The native protocols bind that Noise-authenticated PeerId to the persistent secp256k1 node
identity and exact chain/genesis before serving sync, validator consensus, block gossip or
transaction gossip. Payload, connection, stream, fanout, dedup, per-PeerId inflight and request
rate limits are enforced. Automatic admission of peer-exchange records is deliberately still
disabled until the remaining eclipse/diversity policy is complete.

Keep wallet/public HTTP RPC and validator networking as separate security surfaces. A normal
validator should leave `--host 127.0.0.1` for RPC and expose only its native P2P TCP port to
other nodes. If an RPC listener must bind non-loopback, the CLI fails closed unless consensus
peer authentication is configured; put public wallet RPC behind a separately rate-limited TLS
reverse proxy rather than exposing validator RPC directly. Native P2P performs no automatic
UPnP/NAT port mapping: an operator behind NAT must explicitly forward the selected TCP P2P port
or use a publicly reachable host. Do not forward the loopback validator RPC port merely to make
P2P reachable.

When `--peer-token-file` is configured, non-loopback peers must use `https://` URLs so
the Bearer credential is never transmitted over remote plaintext HTTP. Plain HTTP remains
available for loopback-only local devnets without weakening the authenticated remote path.

For validator deployments, prefer explicit node-identity trust over a shared fleet token.
Each node persists a separate secp256k1 node identity in its data directory. Configure every
allowed remote node with repeated `--trusted-peer-public-key <key>` flags. Once at least one
trusted key is configured, consensus writes (`/proposal/attest`, `/round/skip`, `/block`) require
a domain-separated node signature binding the chain/genesis, method, path, canonical body hash,
timestamp and random nonce; a legacy Bearer token cannot bypass that policy. Replays older than
60 seconds or duplicate nonces are rejected. Remote authenticated peers still require HTTPS:
application signatures authenticate the node, while TLS protects confidentiality and transport.

`--advertise-peer https://node.example:9137` publishes the separately signed, one-hour peer
record at `/peer-record`. Treat advertised records as discovery metadata, not automatic trust:
operators must establish trusted public keys out of band until bounded dynamic admission and
peer scoring are implemented.

```sh
node dist/src/cli.js node --genesis genesis.json --data data-a --validator-key validator-a.json --port 9137 --peer http://127.0.0.1:9138
node dist/src/cli.js node --genesis genesis.json --data data-b --validator-key validator-b.json --port 9138 --peer http://127.0.0.1:9137
```

Native configured-peer example (replace each placeholder with the PeerId printed by the remote
node on startup):

```sh
node dist/src/cli.js node --genesis genesis.json --data data-a --validator-key validator-a.json --p2p-listen /ip4/0.0.0.0/tcp/9140 --p2p-peer /dns4/node-b.example/tcp/9140/p2p/<NODE_B_PEER_ID>
node dist/src/cli.js node --genesis genesis.json --data data-b --validator-key validator-b.json --p2p-listen /ip4/0.0.0.0/tcp/9140 --p2p-peer /dns4/node-a.example/tcp/9140/p2p/<NODE_A_PEER_ID>
```

Create another key for a funded wallet and submit a signed transfer:

```sh
node dist/src/cli.js transfer --key wallet.json --rpc http://127.0.0.1:9137 --chain-id zyron-devnet-1 --to <address> --amount-atoms 100000000 --fee-atoms 1000
```

Never commit generated key files or live genesis operator secrets.

## Rotate the validator set

Validator rotation is intentionally multi-party. The initiator creates a public proposal file from live chain context, each active validator signs that proposal independently, then the initiator assembles and submits the quorum transaction. Private validator keys never need to be collected on one machine.

```sh
node dist/src/cli.js validator-proposal --out update.json --rpc http://127.0.0.1:9137 --key initiator.json --activation-height 500 --validator-public-key <new-validator-a-public> --validator-public-key <new-validator-b-public>
node dist/src/cli.js validator-approve --proposal update.json --key validator-a.json --out approval-a.json
node dist/src/cli.js validator-approve --proposal update.json --key validator-b.json --out approval-b.json
node dist/src/cli.js validator-submit --proposal update.json --approval approval-a.json --approval approval-b.json --key initiator.json --rpc http://127.0.0.1:9137
```

The chain, not the CLI, is authoritative: the initiator must be active, approval signatures must come from a unique >2/3 quorum of the active set, the initiator nonce must be next, and activation must be at least 100 blocks after the inclusion height.

## Schedule a protocol upgrade or rollback

Protocol changes use the same multi-party safety model. An active validator proposes a target protocol version and activation height, a >2/3 quorum independently approves the exact proposal, and the initiator submits it. Operators can pre-schedule a later rollback version as a separate higher activation height. A binary that does not support the version active at the next height refuses to produce or accept blocks instead of silently forking.

```sh
node dist/src/cli.js protocol-proposal --out upgrade.json --rpc http://127.0.0.1:9137 --key initiator.json --activation-height 500 --protocol-version 2
node dist/src/cli.js protocol-approve --proposal upgrade.json --key validator-a.json --out protocol-approval-a.json
node dist/src/cli.js protocol-approve --proposal upgrade.json --key validator-b.json --out protocol-approval-b.json
node dist/src/cli.js protocol-submit --proposal upgrade.json --approval protocol-approval-a.json --approval protocol-approval-b.json --key initiator.json --rpc http://127.0.0.1:9137
```

Scheduling version 2 does not make a version-1 binary understand version 2. The upgraded binary must be deployed and verified before the activation height. This separation is deliberate: governance authorizes when a protocol may activate; node software determines which protocol semantics it actually implements.

## RPC surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | Chain ID, pinned genesis hash, height, tip hash |
| GET | `/healthz` | Lightweight node health and height |
| GET | `/metrics` | Structured node height, mempool, validator-count and uptime metrics |
| GET | `/blocks?from=1&limit=100` | Bounded finalized-block sync |
| GET | `/balance/<address>` | Exact atom balance |
| GET | `/nonce/<address>` | Confirmed account nonce |
| POST | `/tx` | Strictly parsed signed transaction submission |
| POST | `/proposal/attest` | Validator-only proposal validation and attestation |
| POST | `/round/skip` | Validator-only, deadline-gated signed skip vote for certified view change |
| POST | `/block` | Validate and persist a finalized quorum block |

## Consensus safety boundary

Fallback rounds require a strictly-greater-than-2/3 signed skip certificate for the preceding round. A validator's fsynced signing journal makes attestation and skip mutually exclusive inside the same `(height, round)`. For round 2 and later, validators require the preceding skip quorum certificate before signing the next skip, so a node cannot jump view-change rounds after an outage. The coordinator progresses missed rounds sequentially.

This removes the earlier single-proposer liveness stop, but it does not replace an independent consensus audit or adversarial soak testing. The implementation is suitable for controlled multi-validator devnet/testnet operation; public-mainnet release remains gated by the evidence in `../docs/STANDALONE_L1_READINESS.md`.

## Release artifacts

Tags matching `l1-v*` run the standalone L1 release workflow. The workflow installs the
locked dependency graph, repeats typecheck/tests/runtime audit, builds the node, packages
only the runtime distribution and operator README, writes `SHA256SUMS`, and creates a
GitHub artifact attestation for both files. The resulting tarball is an operator artifact;
the package remains `private` and is not published to the npm registry.

Before promoting a release, verify its checksum and GitHub attestation and confirm that
the tag resolves to the reviewed commit. Release provenance does not replace the
independent audit, production key custody, genesis freeze, or operational drills listed
in the readiness gate.

## Deterministic checkpoint snapshots

An operator can export the fully replay-validated chain state, finalized tip, validator
schedule and protocol schedule into one deterministic artifact:

```sh
node dist/src/cli.js snapshot --genesis genesis.json --data ./data --out checkpoint.json
```

The command prints a SHA-256 digest covering the entire canonical snapshot. Publish/pin
that digest through an independent trusted channel before treating the file as a checkpoint.
The node deliberately does **not** fast-import snapshot files yet: a bare state root does
not commit validator/protocol schedules, so skipping history without an independently
trusted full-snapshot digest would weaken consensus safety.

Local recovery checkpoints are different: they are created only after the finalized block
log is durable, bind the full chain/genesis/tip/state/governance snapshot, and are revalidated
against their exact finalized-log boundary before suffix replay. To measure the restart
benefit on synthetic finalized history without making wall-clock timing a flaky CI gate:

```sh
npm run bench:restart
ZYRON_BENCH_BLOCKS=2000 npm run bench:restart
```

The benchmark first reopens with the checkpoint hidden (full replay), then restores the same
checkpoint and reopens via verified suffix replay. It fails if either path reaches a different
tip or if the checkpoint path is not actually used, and prints both timings plus the observed
speedup. Benchmark timing is evidence for capacity planning, not a consensus correctness rule.
