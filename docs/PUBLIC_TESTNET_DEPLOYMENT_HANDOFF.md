# Public testnet deployment handoff

Status: preparation only. Public-testnet activation and public mining remain disabled. This is an operator handoff, not evidence that a network has launched. The canonical gate list is `l1-launch-authorization.json`; the nine gates in `STANDALONE_L1_READINESS.md` must each have independently reviewed evidence.

## Proposed topology (not provisioned)

| Role | Initial engineering layout | Exposure and custody |
| --- | --- | --- |
| Validators | Four separately operated hosts; finality requires three of four | Native authenticated P2P; RPC on loopback; separate audited remote signer/HSM for each validator |
| Bootstrap | At least two independently operated reachable nodes | Publish pinned PeerIds and native TCP multiaddresses through authenticated channels |
| Archive/checkpoint | At least two full-history nodes on independent storage/provider domains | Preserve finalized history; publish checkpoint hash and finalized-tip anchors through a channel independent of serving peers |
| Wallet/miner RPC | At least two non-validator nodes | TLS edge proxy; rate/body/response limits; never expose signer endpoints or validator RPC |
| Monitoring | Independent observers in at least two failure domains | Collect local metrics and compare finalized tips; protect access to operational telemetry |

Counts are a proposed rehearsal layout, not proof of operator independence. Do not co-locate all validators on one host or treat different service names as independent providers. Hostnames, public PeerIds, operator identities, hardware sizes, network rules, public chain ID, genesis and signer custody must be supplied and reviewed before materializing a deployment. No paid resources or DNS changes are made by this document.

## Installation and rollout sequence

1. Select one exact reviewed source SHA and its matching release tarball, SBOM, checksums and provenance. Use the release-artifact-only procedure in `INDEPENDENT_OPERATOR_CHALLENGE.md` and the existing `l1/scripts/artifact-operator-rehearsal.mjs` as the automated installation/restart reference. A candidate CI artifact is not an approved public release.
2. Verify the downloaded bytes against independently obtained checksums and verify provenance; extract into a fresh versioned directory on Linux. Use the supported Node runtime and the locked production dependencies. Do not update a live installation or copy live databases during installation.
3. Independently authenticate the exact public testnet genesis hash/chain ID and bootstrap PeerIds. No mainnet allocation or economics may be inferred from development genesis generation.
4. Configure non-signing bootstrap/archive nodes first, then non-signing RPC nodes. Use a separate data directory and OS identity per node. Full history is retained by default; do not run `prune-finalized` on archive nodes.
5. Configure validator signer URLs, pinned public keys and owner-only token files out of band. Use the node command in `L1_OPERATIONS_RUNBOOK.md`, including `--validator-signer-token-file`, `--host 127.0.0.1`, native `--p2p-listen`, two or more pinned `--p2p-peer` entries, and verified `--p2p-peer-group` assignments. Do not copy validator private keys between hosts.
6. Validate TLS/proxy routing using the RPC trusted-proxy contract in `L1_OPERATIONS_RUNBOOK.md`. HTTP liveness alone is not rollout acceptance. Admit validators only through the published validator-governance procedure after the public activation gate is reviewed and opened.
7. Run the acceptance matrix below against the exact release and archive source SHA, configuration hashes, hardware/provider identity, timestamps and failures. Retain the prior installation and state for reviewed rollback; never erase the signing journal or reduce quorum to recover progress.

Local Windows preparation is available through `START-DEVNET.cmd` and `l1/LOCAL_DEVNET.md`. It creates a private development chain and cannot provide public deployment evidence. The current desktop sandbox cannot access WSL (`E_ACCESSDENIED`); Linux CI is the available execution environment for validator rehearsals.

## Validator, miner and tester onboarding

Validators follow `INDEPENDENT_OPERATOR_CHALLENGE.md` and `L1_OPERATIONS_RUNBOOK.md`: independently obtain artifacts and genesis anchors, synchronize without signing, rehearse same-data restart and checkpoint recovery, then enable the approved signer only after admission. Never submit a private key, password or signer token to a website or maintainer.

Miners use `l1/MINING.md` after a separately approved protocol-v5 network and public-mining release exist. The miner checks chain ID and genesis hash, signs locally and requires HTTPS for remote RPC. Work secures issuance eligibility; configured PoA validator quorum still determines finality. Package availability does not activate mining, and no real-value purchase or transfer is needed for testing.

Testers obtain the published non-value testnet profile and encrypted local wallet through the documented CLI flow. Verify RPC `/status` chain/genesis identity before transactions. Record transaction IDs, sender nonce, receiver balances and finality at independent nodes. Report rejected/stale mining claims, RPC failures, inconsistent finalized hashes and recovery failures without attaching wallet files or passwords. Never use a mainnet wallet or assume test coins have value.

## Acceptance and monitoring matrix

| Exercise | Existing automation / procedure | Evidence still required |
| --- | --- | --- |
| Two-validator transfer, quorum loss, restart | `l1/scripts/local-devnet.mjs --check` | Exact-run success; investigate every timeout rather than treating reruns as a fix |
| Consensus/network faults | `l1/scripts/composite-adversarial-soak.mjs` | CI is a simulation; execute real Internet latency/loss/partition and hostile RPC/P2P load independently |
| Hard crash and node catch-up | `l1/scripts/multiprocess-native-recovery.mjs` | Target-host process crash and same-state recovery drill |
| Checkpoint restore | `l1/scripts/disaster-recovery-rehearsal.mjs` | Independent trusted anchors, separate-host restore and measured recovery duration |
| Upgrade/rollback | `l1/scripts/mixed-version-rehearsal.mjs` | Reviewed operator rollout across actual failure domains |
| Mining, wallet, RPC | Full Node 22/24 L1 tests and miner candidate workflows | Independent hardware contention, inclusion fairness/stale-work measurements and target calibration |
| Sustained service | `HOSTED_DURATION_SOAK_EVIDENCE.md` | At least six real hours on approved always-on hosts, monotonic progress, bounded finality gaps and accounted restarts |
| Monitoring | `L1_OPERATIONS_RUNBOOK.md` telemetry and alerts | Independent observer records, same-height tip comparison, resource/clock/storage alarms and incident drill |

Keep liveness (`/healthz`) distinct from readiness (`/readyz`). Page on persistence or validator-clock faults and conflicting finalized tips. Record disk pressure, RSS/CPU, peer diversity and signer errors. Avoid blind restart loops and artificial keepalive traffic.

## Observed infrastructure boundary

On 2026-09-17 the connected Render inventory showed the two L1 rehearsal services on the Free plan in Ohio, both last deployed from `d701aa0ee87fef4b7a436f35ee0a39b5a02568ef`. A deployment marked `live` is not a measurement of continuous availability. These services do not prove always-on uptime, independent operators, independent provider domains or current-release deployment. No service was upgraded or created.

Required external handoff: approved always-on hosts and deployment access; genuinely independent operators and checkpoint/monitoring providers; external security review and retest; audited signer/HSM custody; enforced branch/release protection; target-hardware capacity and mining measurements; independent succession custodians. Existing evidence-format validators check consistency and must not be used to manufacture these facts. Track closure in GitHub issues #260 and #249; miner publication security is tracked in #892. Keep activation disabled until each relevant gate is independently closed.
