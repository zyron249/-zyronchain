# ZyronChain protocol v6: operator guide and incident runbook

- **Status:** engineering draft for review. It authorizes nothing: no network, activation height, validator set or release is chosen here.
- **Pinned to:** `origin/main` `59940965197a91d882dbebd44f716c9dcec2ef07` (2026-10-11 11:19 EDT). File and line references are for that commit unless stated otherwise.
- **Current facts:**
  - Protocol v6 (locked two-phase BFT, PR #945) is merged.
  - v6 is **not active on any value-bearing network**. (Update 2026-10-18: the hosted open TESTNET, which has no value, runs v6 from height 101 with 4 project-operated validators in one process; see `docs/OPEN_TESTNET.md`.)
  - There is no mainnet.
  - There is no network with independent operators. All running validators are project-operated (host configuration not verified in this guide).
- **PRs that changed this guide (all merged 2026-10-12):** #963 (v6 snapshot/checkpoint verification, `c81ec66`), #966 (downgrade refusal, `f8f46b5`), #967 (lone journal lock row, `d1bdc17`), #968 (snapshot tip body, `cd9729b`). **Update 2026-10-18:** sections below that compare "today on main" with "if the PR merges" were written before these merges. For each of these four PRs the **"if/with PR" behaviour is now the behaviour on main**; the "today on main" text describes the earlier code and is kept only for nodes still running a binary older than those merges.
- **Review status:** v6 has had project self-reviews and one AI-assisted retest (result: v6 safety/liveness fix confirmed; not a formal proof and not an audit). **No independent human audit has taken place.**
- **PR-dependent sections:** text marked **"Today on main"** describes merged behaviour. Text marked **"If #NNN merges"** or **"With PR"** describes behaviour that exists only on an open pull request and must not be relied on until that PR is merged and deployed.

Primary sources: `docs/V6_SAFETY_PROOF_OBLIGATIONS.md` (operator rules §4, durability §3), `docs/L1_OPERATIONS_RUNBOOK.md`, `l1/README.md`. The normative design specification is [`docs/consensus/V6_CONSENSUS_SPEC.md`](consensus/V6_CONSENSUS_SPEC.md) (referred to in code comments as `F01_CONSENSUS_DESIGN.md`).

---

## 1. What changes for an operator under v6

| Topic | Legacy v1-v5 | v6 (from activation height A) | Source |
|---|---|---|---|
| Finality evidence | attestations + skip certificates; `roundCertificate` outside the block hash (F-13, accepted risk) | commit certificate over `{chainId, height, commitRound, blockHash}`; `roundCertificate` must be empty | `l1/src/consensus-v6.ts`, `l1/src/block.ts` |
| Votes per round | attest **or** skip (exclusive; split halts forever, F-01) | proposal, prepare, lock+commit, timeout; a timeout stays legal after prepare/commit | `V6_CONSENSUS_SPEC.md` §6.3 |
| Round change | skip-certificate chain | timeout certificate (TC) of q timeouts; next leader must re-propose the highest QC | `consensus-v6.ts` `validateTimeoutCertificate` |
| Journal | `signing-journal.ndjson` legacy rows `{height,round,kind,value}` | v2 rows `{"v":2,height,round,step,value[,lockRound]}`; no `kind` key, so an old binary refuses them (`Corrupt signing journal entry`) | `l1/src/storage.ts` ~L930-1300 |
| Extra durable state | none | `consensus-state/H-<h>.json` (lockedQC/highQC/validBlock) and `H-<h>-r-<r>.proposal.json`; liveness aids only, never safety state | `V6_SAFETY_PROOF_OBLIGATIONS.md` §3.3 |
| Native protocol | `/zyronchain/consensus/1.x` | `/zyronchain/consensus/2.0.0` | `l1/src/p2p-consensus.ts` |
| Timing | 30 s round window | `V6_ROUND_BASE_MS`=30,000, step 5,000, max 120,000, `V6_TIMEOUT_GUARD_MS`=2,000, fallback poll 3,000 ms, `V6_MAX_ROUND`=1,000,000 | `consensus-v6.ts:26-36` |
| Remote signer | supported | v6 intents **refused** unless `--validator-signer-allow-v6 true` | `l1/src/validator-signer.ts:24-30,85-88`, `l1/src/cli.ts:344-350` |

Quorum is `q = floor(2n/3)+1` and `f = n - q`. **n = 2 and n = 3 give f = 0**: any unavailable validator stops progress until it returns. v6 then resumes by itself, but these sets have no crash tolerance. A network that claims crash tolerance needs n ≥ 4 (`V6_SAFETY_PROOF_OBLIGATIONS.md` §4.6). The current 2-validator setup has **no fault tolerance**.

## 2. Install and upgrade

### 2.1 Release artifacts
- There are **no `l1-v*` release tags or GitHub releases for the L1**. The existing releases v0.1.0-v0.7.0 (June 2026) belong to the legacy Python stack. The release workflow `.github/workflows/l1-release.yml` would publish a tarball, `SHA256SUMS`, an SPDX SBOM and a provenance attestation when an `l1-v*` tag is pushed. It has never run for a tag.
- Until a release exists, operators build from a commit the owner approved:

```sh
git clone https://github.com/zyron249/-zyronchain.git && cd -- -zyronchain
git checkout --detach <APPROVED_COMMIT_SHA>
cd l1
npm ci                 # Node >= 22 (l1/package.json "engines"); CI runs Node 22 and 24
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
npm run build          # output: dist/src/cli.js
```

- Record the commit SHA, the Node version and the `npm ci` lockfile hash (`sha256sum l1/package-lock.json`) in the operator log.

### 2.2 Rolling upgrade of a validator (before v6 is scheduled)
1. Read `GET /protocol` → `{currentVersion, nextVersion}` and `GET /status` → `{chainId, genesisHash, height, tipHash}` on every validator. Note height and tip.
2. Stop cleanly with `SIGTERM`. Wait for the `ZyronChain node shutdown complete` log line (`L1_OPERATIONS_RUNBOOK.md` §2). Never start a second process on the same data directory: the writer lease must be released first.
3. Replace the binary in place. **Keep the same data directory.** Never copy it, never restore it from a snapshot (see §6).
4. Start with the same flags. Check `GET /readyz` → 200, `GET /status` height increasing, and that the tip matches the other validators.
5. Upgrade one validator at a time. With n = 2 every restart pauses finality. Plan the restart window and expect a `stale-tip` reason if it exceeds `--ready-max-tip-age-ms` (default 600,000 ms).

### 2.3 Prerequisites before anyone proposes v6 (checklist)
- [ ] Every validator runs a v6-capable binary (supported versions `{1,2,3,5,6}`, `l1/src/chain.ts:80`). Old binaries fail-stop at A by design.
- [x] #963 merged (`c81ec66`): snapshot/checkpoint/state-sync paths verify v6 tips with the commit certificate (NEW-R1, §8). Every validator binary must include it.
- [x] #966 merged (`f8f46b5`): a scheduled v6 can no longer be cancelled by governance (§9).
- [x] #967 merged (`d1bdc17`): the lone-lock-row case recovers by itself (§7.3).
- [ ] Remote-signer plan decided (§10). Since P0-09 (`cbdca51`) the reference signer (`l1/src/remote-signer-service.ts`) keeps its own journal v2 and enforces the v6 rules; it is a reference implementation, not an HSM.
- [ ] Clocks synchronized well inside the 2 s timeout guard (NTP/chrony on every host).
- [ ] Storage with honest `fsync` (no volatile write cache without power-loss protection; `V6_SAFETY_PROOF_OBLIGATIONS.md` §3.5).
- [ ] Rehearsal of the activation on a non-value test network with ≥ 4 validators **Not done yet.**
- [ ] An external consensus review **Not done yet.**

## 3. Activation procedure and margin

### 3.1 Rules enforced by the code
| Rule | Value | Where | Kind |
|---|---|---|---|
| Minimum delay for any protocol upgrade | activation ≥ current height + 1 + 100 | `MIN_PROTOCOL_UPDATE_DELAY`, `chain.ts:77` | consensus (block validity) |
| Minimum v6 margin | activation ≥ current height + 1 + **2,000** | `V6_MIN_ACTIVATION_MARGIN_BLOCKS`, `consensus-v6.ts:36`; checked in `cli.ts:765` (`protocol-proposal`) and `node-base.ts:463-466` (`submitTransaction`) | **node/mempool policy only**. A block that carries a v6 upgrade with a 100-2,000 block margin is still valid |
| Approvals | > 2/3 of the active validators (q) | `validateProtocolUpgradeAuthorization`, `chain.ts` | consensus |

### 3.2 Recommended margin: ≥ 2,880 blocks
- 2,880 blocks at the 30 s target is about 24 h.
- The code minimum of 2,000 blocks is about 16.7 h.
- Choose the margin so that every operator can upgrade, verify and roll back the binary (not the protocol) inside the window, across time zones.
- Larger margins are safe. A margin is measured in blocks, so a stalled chain lengthens wall-clock time.

### 3.3 Steps (all validators must already run the v6-capable binary)

```sh
# initiator (an active validator)
node dist/src/cli.js protocol-proposal --out v6-upgrade.json --rpc http://127.0.0.1:<RPC_PORT> \
  --key <initiator-keystore.json> --protocol-version 6 --activation-height <H_NOW + 1 + MARGIN>
# every approving validator, offline, on the exact file
node dist/src/cli.js protocol-approve --proposal v6-upgrade.json --key <validator-keystore.json> --out approval-<n>.json
# initiator submits with >= q approvals
node dist/src/cli.js protocol-submit --proposal v6-upgrade.json --approval approval-1.json --approval approval-2.json \
  --key <initiator-keystore.json> --rpc http://127.0.0.1:<RPC_PORT>
```

- `<RPC_PORT>` and the key file names are placeholders. Pass the keystore password through `ZYRON_KEYSTORE_PASSWORD_FILE` (a `0600` file), never on the command line.
- `GET /protocol` only returns `{currentVersion, nextVersion}` for the current and next height (`node-base.ts:370-376`). `GET /status` returns `{chainId, genesisHash, height, tipHash}` (`:361-368`). **No RPC on main exposes the full scheduled protocol table.** Confirm inclusion of the upgrade transaction from the submitting node's output and block contents, and record the activation height in the operator log.
- `unsupported-next-protocol` appears in `/readyz` only when the **next** height is A, i.e. one block before activation. It is not an early warning. Verify every validator's binary version (commit SHA) out of band before submitting the upgrade. **A node still on an old binary at A stops at A.**
- At A, each height runs under exactly one protocol (`protocolVersionAt(H)`). A legacy split (F-01) at a height < A still halts the chain **before** A, and activation cannot rescue it (`V6_CONSENSUS_SPEC.md` §12 item 3).

## 4. Readiness (`/readyz`) reasons

`GET /readyz` returns 200 when `reasons` is empty, otherwise 503 `{ready:false, height, reasons:[...]}` (`node-base.ts:378-394`, route `:1116-1119`). `/healthz` is liveness only.

| Reason | Meaning | First action |
|---|---|---|
| `persistence-unhealthy` | block/state persistence fault; node must not sign | stop signing, preserve forensic copies, restart (`L1_OPERATIONS_RUNBOOK.md` §6 "Disk/state corruption") |
| `signing-journal-unhealthy` | journal append/fsync failed; journal refuses further reservations ("Signing journal persistence fault requires validator restart") | stop, check disk/filesystem, restart. **Never delete the journal** |
| `validator-clock-unhealthy` | wall clock moved backwards beyond tolerance; latched until restart ("Validator clock fault requires process restart") | fix time sync, then restart |
| `unsupported-next-protocol` | the binary does not support the protocol version scheduled for the next height | upgrade the binary (before A) |
| `stale-tip` | finalized tip older than `--ready-max-tip-age-ms` (default 600,000 ms, `node-base.ts:102`) | finality-halt runbook (§5, §11) |
| `consensus-catching-up` | **legacy only**: bounded skip-chain catch-up after a long stall (F-02) | wait; it does not apply at v6 heights |
| `syncing` | a block sync is in progress towards a peer tip more than one block ahead (HTTP `syncFrom`/`syncAny` and native sync); lasts only while that sync runs | wait; if it recurs without progress, check the peer and `stale-tip` |
| `consensus-quorum-unreachable` | this validator, as leader, could not form a TC, prepare QC or commit certificate for the current tip | check peer connectivity; clears at the next quorum or when the tip advances |
| `validator-signer-unavailable` | the last signing request to the configured signer failed | check the remote signer; clears on the next successful signature |

There is no peer-count reason: lost peers show up as `consensus-quorum-unreachable` on a validator whose own attempt failed, and as `stale-tip` elsewhere. Monitor peer count separately.

## 5. Prepare / commit / timeout diagnostics

### 5.1 Telemetry
- `GET /metrics` includes `consensusV6` **only while v6 governs the next height** (`node-base.ts:921-926, 1120-1133`): `{height, lockRound, maxVoteRound, maxTimeoutRound}`.
  - `lockRound` = -1 means no lock at this height.
  - `maxVoteRound`/`maxTimeoutRound` show how far this validator has voted or timed out.
  - Compare across validators: if they diverge by more than one round for a long time, check connectivity and clocks.
- Legacy `roundSkipVotes` diagnostics (`L1_OPERATIONS_RUNBOOK.md` §3) do not apply to v6 heights.
- **UNVERIFIED:** whether `/metrics` exposes per-step counters (prepare QCs formed, TCs formed). Only the four fields above were confirmed in code.

### 5.2 Expected refusals (normal or benign)
| Message (exact prefix) | Source | Meaning |
|---|---|---|
| `Round timeout deadline has not elapsed` | `node-base.ts:775` | a peer asked for a timeout vote early; retried by the pacemaker |
| `Configured validator is not the round leader` / `... not the block proposer` | `node-base.ts:842,871` | request reached a non-leader; benign |
| `Validator has already moved past this round` | `node-base.ts:803` | late request for an old round |
| `Validator holds a QC above the requested round` | `node-base.ts:806` | this validator has newer evidence; the requester must catch up |
| `Legacy consensus messages are not accepted at protocol v6 heights` | `node-base.ts:618` | an old binary or legacy client at a v6 height; upgrade it |
| `Protocol v6 consensus is not active at the next height` | `node-base.ts:634` | a v6 message before A; check the activation schedule |

### 5.3 Safety refusals (the journal prevented equivocation; investigate)
| Message | Source | Meaning | Action |
|---|---|---|---|
| `Protocol v6 prepare refused: conflicts with the validator's lock` | `storage.ts:1267` | SAFE-VOTE: the proposal is neither the locked block nor justified by a higher QC | normal under a faulty or partitioned leader. If it repeats at many heights, suspect a buggy or malicious leader |
| `Protocol v6 commit refused: differs from own prepare vote` | `storage.ts:1290` | commit request for another block than this validator prepared | investigate the leader. Preserve logs |
| `Protocol v6 commit refused: lock may not move backwards` | `storage.ts:1293` | request would lower the lock | investigate. Preserve logs |
| `Protocol v6 validator action refused: round already timed out` / `a later round was already voted` | `storage.ts:1203-1204` | late action for a round this validator left | benign if isolated |
| `Conflicting validator action prevented for consensus round` | `storage.ts:1246,1264,1287` | a second, different value for the same (height, round, step) was refused | **incident**: two different requests for one slot. Check for a second process using the same key (§6) |
| `v6 commit block does not match its prepare QC` | `node-base.ts:742` | malformed or forged commit request | preserve evidence; check the peer (F-12 allowlist) |
| `Unjustified v6 proposal must carry this leader's own fresh block` | `node-base.ts:879` | leader rule violation | preserve evidence |

### 5.4 Finality halt at a v6 height
1. Stop automated restart loops. Preserve logs, `signing-journal.ndjson` and `consensus-state/` copies (read-only copies; never edit the originals).
2. Compare `/status` (height, tip), `/metrics.consensusV6` and `/readyz` on every validator.
3. With n = 2 or 3, the usual cause is one validator down or unreachable: bring it back. v6 resumes without manual steps once q validators communicate (`V6_SAFETY_PROOF_OBLIGATIONS.md` L5).
4. Check clocks (skew must stay well under 2 s) and connectivity on `/zyronchain/consensus/2.0.0` (with the F-12 allowlist `--p2p-consensus-peer`, make sure every validator's PeerId is listed).
5. If `maxTimeoutRound` grows on all validators but no TC forms, check that timeout votes reach the leader (firewall, allowlist, certificate size limits).
6. Do **not** delete journals, lower quorum, fabricate votes, or adopt an untrusted checkpoint (`L1_OPERATIONS_RUNBOOK.md` §6).
7. Rounds back off linearly up to 120 s. A long stall reaches high round numbers, which is expected (O-1: high starting round after a re-proposal adds latency only).

## 6. Hard rule: never restore a validator from an old disk or VM snapshot

> **Never restore a validator from an old disk, volume, VM image or filesystem snapshot. Never copy a data directory to start a second instance. Never run two processes with the same validator key.**

- **Why:** the signing journal and the v6 lock rows are the only protection against double-signing. A restored directory has forgotten the votes and locks written after the snapshot. The validator can then sign a conflicting prepare or commit and become Byzantine. `l1/test/v6-fault-rollback.test.ts` demonstrates this as a negative control. The AI-assisted F-01 retest reached the same result: rollback is outside the safety model, and `fsync` is not anti-rollback protection.
- A validator restored this way counts as faulty against `f`. With n = 2 or 3, f = 0, so a single such event can break safety.
- **Recovering a lost or destroyed validator host** (`V6_SAFETY_PROOF_OBLIGATIONS.md` §4.1):
  - (a) Start from an **empty** data directory with the same key **only after every height that validator may have signed is finalized** on the surviving validators. Sync blocks first, as a non-signing node if possible. Or:
  - (b) Rotate the validator key through the quorum-authorized `validator-proposal` / `validator-approve` / `validator-submit` flow (delayed ≥ 100 blocks) and start fresh with the new key.
- Backups are for **non-validator** recovery and archive: use `snapshot` (offline, takes the writer lease), then `checkpoint-install` into a **new empty** directory with independently trusted `--tip-hash` and `--sha256` (`L1_OPERATIONS_RUNBOOK.md` §4-5).
  - Binaries before #963 (`c81ec66`) reject v6 tips on this path (NEW-R1). Since #963 it works for v6.
- Cloud features that silently snapshot or roll back disks, or live-migrate with a disk revert, must be **disabled** for validator volumes. **UNVERIFIED:** current settings on the existing validator hosts.

## 7. Journal v2 recovery

General rules: never hand-edit, truncate or delete `signing-journal.ndjson` or `consensus-state/` (`V6_SAFETY_PROOF_OBLIGATIONS.md` §4.2). Preserve copies before any action. One writer per data directory (OS lease).

| Situation on startup | Behaviour today (main) | With PR | Operator action |
|---|---|---|---|
| Unterminated, unparsable last line (torn tail after power loss) | dropped with fsync, log `Dropped a torn trailing ... record`. If it was part of a lock+commit append, the lock row of that append is dropped too (F-10, #954) | unchanged | none; repeated occurrences mean a storage or power-path fault |
| Complete last row that lost only its newline | kept and re-terminated | unchanged | none |
| Complete v6 **lock row** as the very last row with no commit row (power loss inside one append) | **fatal**: `Torn protocol v6 lock/commit pair in signing journal` (`storage.ts:945,959,1151`). Safe (no signature left) but the validator stays down | **#967**: the lock is kept and completed with the matching commit reservation if consistent; log `Completed a lone trailing protocol v6 lock row`. A lock row followed by any other row stays fatal | today: keep the node down, preserve copies, do **not** edit. Recover per §6 (a) or (b). If #967 merges, upgrade and restart |
| Terminated line that does not parse, corruption before the last row, parsable but invalid row | fatal `Corrupt signing journal entry` | unchanged | storage incident. Preserve copies; recover per §6 |
| Legacy and v2 rows at the same height | fatal `Mixed legacy and protocol v6 signing journal rows` (`storage.ts:955,1154`); v6 actions refused `legacy journal rows exist at this height` (`:1197`) | unchanged | only reachable by operator error across A. Preserve evidence; recover per §6 |
| Two different values for one slot in the file | fatal `Conflicting signing journal history` (`storage.ts:954,1158,1162`) | unchanged | **security incident**: evidence of a copied directory or a second writer. Freeze, preserve, escalate |
| Old (pre-v6) binary opens a journal with v2 rows | fatal `Corrupt signing journal entry` (deliberate downgrade guard, T10) | unchanged | do not downgrade the binary after A |
| Lost or old `consensus-state/H-*.json` | allowed: the lock row is still enforced; the validator reports `highQCRound = -1` and relies on other lock holders for liveness | unchanged | none; liveness only |

## 8. Snapshots, checkpoints, state sync and pruning under v6 (NEW-R1)

- **Today on main** (finding NEW-R1): `ZyronChain.fromTrustedSnapshot` checks v6 tips with the legacy attestation rule and throws `Invalid validator attestation`. This affects `checkpoint-install`, `checkpoint-fetch-install`, `state-fetch-install`, the p2p checkpoint/state sync and the recovery-checkpoint fast path.
  - `prune-finalized` after activation fails with `Verified recovery checkpoint unavailable for pruning` and overwrites the previous good checkpoint.
  - The node then refuses to start with `Pruned finalized history requires a valid compatible recovery checkpoint`.
- **Operator rule for any node still on a binary without #963 (merged `c81ec66`):**
  - Do **not** run `prune-finalized` on any node after v6 activation.
  - Do not plan to bootstrap new nodes from snapshots at v6 heights.
  - Keep ≥ 2 archive (unpruned) nodes.
- **#963** verifies v6 tips with the commit certificate and makes recovery checkpoints write-verify-swap. **#968** binds the snapshot tip body to `header.transactionRoot` (a pre-existing gap on v5 and v6; it matters only if the pinned snapshot digest is attacker-controlled).
- Anchors (`--tip-hash`, `--sha256`) must always come from an independent trusted channel, never from the serving peer (`L1_OPERATIONS_RUNBOOK.md` §1.2).

## 9. Rollback policy

| Phase | Today on main | If #966 merges |
|---|---|---|
| Before A (v6 scheduled, not active) | a quorum can schedule another `protocol_upgrade` (for example back to 5) at a later height | **refused**: once the latest scheduled version is ≥ 6, any entry with a lower version is rejected in mempool admission, pending selection, block validation and trusted checkpoint schedules. "A scheduled v6 activation therefore cannot be cancelled through governance; abandoning it requires a separately reviewed release" (PR #966, `l1/README.md` diff) |
| After A | a quorum-approved downgrade to a legacy version is **accepted** (P0-03 finding A, Medium; `V6_SAFETY_PROOF_OBLIGATIONS.md` §6.1). It would bring back legacy consensus and the F-01 split | refused |
| Binary rollback after A | an old binary fail-stops on v2 rows and on v6 heights (by design) | unchanged |

Operational consequences:
- Treat the v6 governance submission as **irreversible** (it is literally irreversible on main since #966). Do every rehearsal **before** submitting.
- `L1_OPERATIONS_RUNBOOK.md` §7 step 5 ("rehearse a separately quorum-authorized rollback schedule") predates v6. It does not apply to v6 and contradicts #966 (merged). That runbook line needs an update (docs follow-up).
- Pre-activation "rollback" of the **binary** (before A, nothing v6 signed yet) is safe. Do not downgrade a binary after it has written v2 rows.

## 10. Key handling and the remote-signer boundary

| Item | Fact on main | Source |
|---|---|---|
| Local keystore | v1: scrypt N=32,768 (2^15), r=8, p=1 + AES-256-GCM | `l1/src/keystore.ts:7-9` |
| Keystore v2 | scrypt N=2^17, offline sign, migration: **draft PR #921**, not merged, conflicts with main in `l1/src/cli.ts` | PR #921 |
| `keygen` without `--password-file` | writes a **plaintext** private key file (mode 0600) | `l1/src/cli.ts:237-260` |
| Password supply | `ZYRON_KEYSTORE_PASSWORD_FILE` (regular private file) | `cli.ts:992-994` |
| Remote signer client | `--validator-signer-url` (HTTPS, or HTTP on loopback only), pinned `--validator-public-key`, bearer token from `--validator-signer-token-file` (32-512 printable chars), 3 s default timeout; the signature is re-verified | `validator-signer.ts:56-100,167-177` |
| v6 through a remote signer | refused unless `--validator-signer-allow-v6 true`. With it, the node's journal always guards against conflicting votes; whether the signer also enforces the v6 rules depends on the signer (the reference signer does since P0-09, `cbdca51`) | `cli.ts:344-350` |
| Production signer/HSM | none chosen. The reference signer enforces the v6 journal rules at the custody boundary since P0-09 (`cbdca51`); it is not an HSM | `l1/src/remote-signer-service.ts` |

Rules:
1. Never copy a validator key between hosts. Never run two nodes with one key (with or without a signer).
2. **v6 with a remote signer today:** setting `--validator-signer-allow-v6 true` removes the signer as a second line of defence. Use it only with one node per signer and one signer per key, after documenting the residual risk. Recommended: wait for a signer that enforces v6 journal rules. **Owner decision.**
3. Signer tokens and keystore passwords live in `0600` files, provisioned out of band. Never in arguments, environment variables, images, logs or the repository (`L1_OPERATIONS_RUNBOOK.md` §2).
4. Suspected key compromise: disable the signer **without deleting its journal**, preserve logs, rotate through the quorum-authorized delayed validator update (`L1_OPERATIONS_RUNBOOK.md` §6). No emergency path exists in code.
5. With the F-12 allowlist, list every validator PeerId with `--p2p-consensus-peer` (the allowlist is opt-in; making it mandatory is a proposed change and an owner decision).

## 11. Incident quick reference

| Symptom | Classify | Do | Never |
|---|---|---|---|
| `/readyz` `stale-tip` on all validators | finality halt | §5.4 | delete journals, lower quorum |
| One validator fatal on journal open | storage/journal | §7 | edit the file |
| `Conflicting signing journal history` or `Conflicting validator action prevented` repeatedly | possible duplicate key or copied directory | freeze that validator, check for a second process/host, preserve evidence, escalate | restart it elsewhere from a copy |
| Two different finalized blocks at one height | critical consensus incident | freeze signing and upgrade automation; preserve everything; external review (`L1_OPERATIONS_RUNBOOK.md` §6) | pick a winner by convenience |
| Node refuses to start after `prune-finalized` post-v6 | NEW-R1 | restore into a new directory from an unpruned archive node's history (block sync) | overwrite the failed directory |
| `unsupported-next-protocol` | old binary | upgrade before A | run past A on the old binary |
| `validator-clock-unhealthy` | clock | fix NTP, restart | disable the guard |

## 12. Gaps and items to verify

1. The v6 design specification is committed as `docs/consensus/V6_CONSENSUS_SPEC.md`. It predates the implementation; its line references point at the pre-implementation baseline, and the merged fixes #963/#966/#967/#968 are listed in its status note but not reflected in its normative text.
2. No v6 activation has been rehearsed with independent operators. The 2-validator setup has f = 0.
3. A runbook drill script for v6 on a local 4-node devnet does not exist yet.
4. `L1_OPERATIONS_RUNBOOK.md` has no v6-specific steps and contains the pre-v6 rollback rehearsal step (§9 above).
5. No remote signer enforces v6 journal rules.
6. The 2,000-block margin is mempool policy only. A block producer with a modified binary could include a v6 upgrade with a 100-block margin, but it still needs q approvals.
7. UNVERIFIED: host-level disk-snapshot settings, NTP configuration and fsync honesty of the current validator hosts.
8. No RPC exposes the scheduled protocol table, and `unsupported-next-protocol` fires only one block before activation. A pre-activation readiness signal (for example "scheduled version V at height A is unsupported by this binary") would help operators. This is an engineering follow-up, not implemented.
