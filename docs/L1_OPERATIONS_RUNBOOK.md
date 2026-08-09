# ZyronChain standalone L1 operations and disaster-recovery runbook

Status: **pre-mainnet operational specification**. This runbook does not authorize a mainnet genesis, token allocation, validator admission policy, production spend, or production key creation. Those remain explicit launch gates in `STANDALONE_L1_READINESS.md`.

## 1. Safety invariants operators must preserve

1. Never copy a validator private key between validator hosts. Prefer `--validator-signer-url` with a pinned `--validator-public-key`; the signer/HSM must independently enforce anti-equivocation policy.
2. Never restore a checkpoint/state bundle from a peer-provided hash alone. The finalized tip hash **and** snapshot SHA-256 must come through an independent trusted release/checkpoint channel.
3. Never delete the signing journal to recover liveness. A journal conflict is a safety stop and requires incident review.
4. Never bypass `persistenceHealthy=false`. Restart/recovery is required before the validator may resume signing.
5. Never roll an unsupported protocol version across its activation height. Old binaries must fail-stop; operators must prove mixed-version readiness before activation.
6. Keep multiple independently operated archival nodes. Pruning is an explicit local storage policy, not a substitute for network history availability.
7. One data directory has exactly one live writer. Never delete or bypass the node/signing SQLite lease files to force liveness, and do not place validator data on a filesystem whose SQLite locking/durability semantics have not been validated.

## 2. Release and node preflight

Before any rollout, archive evidence for the exact reviewed commit and release artifact:

- tag/commit SHA and PR review record;
- `SHA256SUMS` verification for the L1 tarball;
- checksum verification for the exact release SPDX SBOM and GitHub artifact/provenance attestation verification;
- immutable-SHA-pinned GitHub Actions and reviewed Dependabot update status;
- locked dependency install, typecheck, tests, build and high-severity runtime audit all green;
- supported protocol-version matrix versus the current and next scheduled activation;
- independent security review status and unresolved findings.

Start a node from the reviewed L1 distribution. Keep public wallet RPC separate from validator RPC. Validator RPC should normally remain on loopback; expose the native Noise/libp2p TCP port instead. During planned restarts and rolling upgrades, send `SIGTERM` (or interactive `SIGINT`) and wait for the `ZyronChain node shutdown complete` log before starting the replacement process against the same data directory. The node stops periodic validator/sync/discovery work, drains RPC, stops native P2P and releases the exclusive writer lease in that order.

```sh
node dist/src/cli.js node --genesis genesis.json --data ./data \
  --validator-signer-url https://signer.internal.example/sign \
  --validator-public-key <PINNED_VALIDATOR_PUBLIC_KEY> \
  --p2p-listen /ip4/0.0.0.0/tcp/9140 \
  --p2p-peer /ip4/<BOOTSTRAP_IP>/tcp/9140/p2p/<PINNED_PEER_ID> \
  --p2p-peer-group <PINNED_PEER_ID>=<INDEPENDENT_FAILURE_DOMAIN>
```

Use multiple bootstrap peers sourced from independent operators/failure domains. Do not invent failure-domain labels to satisfy diversity selection.

## 3. Required health telemetry

`GET /metrics` is bounded structured JSON intended for a local collector. At minimum collect:

| Field | Meaning | Alert use |
|---|---|---|
| `height`, `tipHash` | finalized local tip | compare against independent nodes |
| `finalizedBlockAgeSeconds` | age of latest finalized block | finality-stall detection |
| `mempoolSize` | pending transaction pressure | saturation/spam signal |
| `validatorCount` | active/next validator-set size | topology/config sanity |
| `persistenceHealthy` | process may continue durable commits | **page immediately if false** |
| `validatorClockHealthy` | validator signing clock has not moved backward beyond tolerance | **page immediately if false; restart only after clock repair** |
| `firstStoredHeight` | local history-retention boundary | archival/pruning verification |
| `recoveredFromCheckpointHeight` | startup recovery fast-path evidence | recovery audit |
| `recoveredStateV2FromCorruption` | derived state was quarantined/rebuilt | investigate disk/state integrity |
| `uptimeSeconds` | current process lifetime | restart-loop detection |

Infrastructure collectors must also record process RSS/CPU, disk free space/latency/errors, network connections/traffic, signer latency/error rate and independent peer count/failure-domain distribution.

### Provisional testnet SLO/alerts

These are engineering rehearsal thresholds, not a mainnet governance decision:

- Page if `persistenceHealthy` or `validatorClockHealthy` is false, the process repeatedly restarts, or derived-state corruption recovery occurs unexpectedly.
- Page if independently observed finalized tips disagree at the same height.
- Warn when finalized block age exceeds two expected block intervals; page when it exceeds four. Diagnose quorum/partition/signer health before taking action.
- Warn before disk capacity can reach exhaustion within the operator's measured growth window; page on filesystem I/O/fsync errors.
- Alert on sustained peer diversity collapse (all usable peers in one operator/provider/subnet failure domain).
- Alert on signer latency/error bursts before they can consume multiple consensus rounds.

Mainnet launch must replace provisional thresholds with measured public-testnet baselines and an approved SLO/error budget.

## 4. Backup and checkpoint procedure

Do not treat an arbitrary live directory copy as a consistent backup. Export a replay-validated checkpoint:

The snapshot command deliberately takes the same exclusive writer lease as the
node. Stop the node process cleanly and confirm it has exited before exporting;
if a node still owns the directory, snapshot fails closed instead of racing live
State-v2 repair/checkpoint writes.

```sh
node dist/src/cli.js snapshot --genesis genesis.json --data ./data --out checkpoint.json
```

Record the printed snapshot SHA-256 together with the exact finalized tip hash in an independent, access-controlled checkpoint registry. Back up the genesis file, checkpoint artifact, both anchors, release identifier, operator configuration and monitoring evidence. Validator signing keys follow the HSM/remote-signer provider's separately audited backup/recovery policy and must not be embedded in the node backup.

For pruned nodes, keep the recovery checkpoint and retention metadata with the node backup; also retain independently operated archival history elsewhere.

`prune-finalized` is also an exclusive offline maintenance operation. It must
not be run beside a live node; the shared writer lease enforces this fail-closed.
After snapshot/prune maintenance, restart the reviewed binary and verify
`height`, `tipHash`, `persistenceHealthy` and peer catch-up before restoring
validator signing.

## 5. Restore drill

Restore into a **new empty data directory**; never overwrite the failed directory.

```sh
node dist/src/cli.js checkpoint-install \
  --genesis genesis.json --snapshot checkpoint.json --data ./restored-data \
  --tip-hash <INDEPENDENTLY_TRUSTED_FINALIZED_TIP> \
  --sha256 <INDEPENDENTLY_TRUSTED_SNAPSHOT_SHA256>
```

Alternatively fetch over authenticated native P2P with `checkpoint-fetch-install` or `state-fetch-install`, while obtaining the two anchors independently of every serving peer.

The drill passes only if:

1. install/reopen validates chain/genesis/finality/state/governance and exact anchors;
2. restored `height`, `tipHash`, state root and history boundary match the evidence record;
3. the node catches up from multiple authenticated/diverse peers;
4. a non-signing observation window shows no tip divergence or persistence fault;
5. only then is validator signing re-enabled under the original anti-equivocation journal/signer policy.

Record drill duration, software SHA, checkpoint anchors and all deviations. Run the drill repeatedly during the adversarial public testnet and before every mainnet-class release.

## 6. Incident procedures

### Finality halt

1. Stop automated restart loops; preserve logs and exact node/signer state.
2. Compare height/tip across independent operators and failure domains.
3. Check signer availability, validator-set schedule, protocol activation height and clock health.
4. Do **not** delete journals, lower quorum rules, fabricate skip votes, or adopt an untrusted checkpoint.
5. Recover failed nodes from the last independently anchored checkpoint and validated suffix if storage is suspect.
6. Resume signing only after operators agree on the last finalized tip and the incident commander records the recovery decision.

### Conflicting finalized tips

Treat this as a critical consensus incident. Freeze signing/upgrade automation, preserve all block/journal/network evidence, isolate affected validators, and escalate to consensus/security review. Do not choose a winning chain by operator convenience and do not publish a new trust anchor until the root cause and governance response are independently reviewed.

### Suspected validator-key compromise

Disable the compromised signer without deleting its journal, preserve HSM/signer audit logs, and use the existing quorum-authorized delayed validator-set rotation procedure from an uncompromised environment. Emergency timing/admission rules are governance decisions and must not be improvised by node software.

### Disk/state corruption

If `persistenceHealthy` becomes false, stop signing and restart only after preserving forensic copies. Derived State-v2 corruption may be quarantined and rebuilt only after authoritative finalized history/checkpoint replay succeeds. If finalized/pruned authoritative material is corrupt, restore to a new directory from an independently anchored checkpoint; never patch hashes or records in place.

### Network/eclipse suspicion

Compare independently sourced bootstrap peers, PeerIds, subnets and named failure domains. Do not add attacker-supplied peers merely to regain count. Restore diversity using out-of-band verified operator endpoints and confirm finalized-tip agreement before signing resumes.

## 7. Upgrade and rollback rehearsal

Before a protocol activation:

1. publish the exact binary hashes and supported-version matrix;
2. run old/new binaries together on a multi-operator testnet through pre-activation blocks;
3. prove old unsupported binaries fail-stop at activation instead of following a different state machine;
4. prove upgraded validators converge after sequential view changes, crash/restart and partition recovery;
5. rehearse a separately quorum-authorized rollback schedule at a later activation height; include the authenticated State-v2-to-v1 reconstruction path and verify the durable post-restart state root;
6. perform a checkpoint restore using both pre- and post-activation history.

No production activation is considered ready from CI alone; the sustained rehearsal evidence is a mainnet stop-ship artifact.

## 8. Disaster-recovery evidence checklist

For each drill/release retain: commit/tag, binary checksum/attestation, genesis hash, checkpoint tip+digest, validator/protocol schedules, participating independent operators/failure domains, start/end time, observed RTO, data-loss/RPO observation, alert timestamps, restore validation result, catch-up result and signed incident/drill notes.

The project remains **testnet/devnet** until the external audit, public adversarial soak, production key custody, multi-operator launch rehearsal and genesis/economics/governance gates in `STANDALONE_L1_READINESS.md` are independently closed.
