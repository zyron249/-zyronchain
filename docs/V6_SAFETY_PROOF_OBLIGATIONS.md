# Protocol v6 consensus: safety and liveness proof obligations

Status: engineering document (backlog item P0-03). It lists what must be true
for protocol v6 (locked two-phase BFT with timeout certificates, finding F-01)
to be safe and live, which assumptions each claim rests on, and which tests
exercise each obligation. **Tests are evidence, not a proof.** The proof
sketches are in the F-01 design specification (sections 7 and 8, summarized
here). They have not been independently reviewed or machine-checked. All tests
listed here were written by the same AI-assisted engineering process that
implemented v6. An independent review is still required (backlog P0-04,
P5-01).

Notation: `n` validators at height `H` (`validatorsAt(H)`), quorum
`q = floor(2n/3) + 1` (`validatorQuorumSize`, `l1/src/block.ts`), and
`f = n - q` tolerated faulty validators.

| n | q | f (crash or Byzantine) | remark |
|---|---|---|---|
| 2 | 2 | 0 | functional only: any unavailable validator stops progress until it returns |
| 4 | 3 | 1 | smallest set with real BFT |
| 7 | 5 | 2 | multi-operator target |

## 1. Fault model and assumptions

- **A1 Signatures.** Ed25519/secp signatures are unforgeable. Every v6 message
  is domain separated (proposal, prepare vote, commit vote, timeout) and bound
  to `{chainId, height, round, ...}`.
- **A2 Faults.** At most `f` validators are faulty at a height. A validator is
  faulty if it is Byzantine, if it is crashed for good, or if it violates any
  operator rule in section 4 (for example it was restored from an old disk
  image).
- **A3 Safety is timing-free.** Safety must hold under asynchrony: arbitrary
  message loss, delay, duplication and reordering, partitions (symmetric or
  asymmetric), clock skew of any size, and crashes at any instruction.
- **A4 Liveness is partially synchronous.** After an unknown global
  stabilisation time (GST) every message between honest validators arrives
  within a bound, honest clocks differ by at most the timeout guard (2 s), and
  at least `q` honest validators are up and connected.
- **A5 Storage.** See section 3: an `fsync` that returned means the data
  survives a crash or power loss; data that was written but not yet synced may
  be lost or torn; `rename` is atomic, and is durable once the directory is
  synced.

## 2. Obligations

### 2.1 Safety

| ID | Obligation | Argument | Exercised by |
|---|---|---|---|
| S-Q | **Quorum intersection.** Any two quorums of `q` validators intersect in at least `2q - n >= f + 1` validators, so in at least one honest validator. Requires `n >= 3f + 1`, i.e. `q > 2n/3`. Quorum is never lowered for small `n`. | arithmetic on `validatorQuorumSize` | `consensus-certificate-model.test.ts` (a lower quorum for n = 3 is shown unsafe); `consensus-v6-primitives.test.ts` (QC/TC/finality certificates need `q` distinct members); `v6-fault-scenarios.test.ts` and `v6-fault-n2-n7.test.ts` scenario `byzantine-f` (f Byzantine validators that sign every prepare/commit request and equivocate as leaders; no conflicting certificate or finality) |
| S1 | **One value per (H, r, step) per honest validator, durable before the signature.** The journal row (or the lock+commit pair) is fsynced before the signature is released; an ambiguous write fail-stops the journal instance; replay restores every row. | spec §6, §7.1, §9.1 | `f01-journal-v2.test.ts`; `f01-v6-boundary.test.ts` T5; `v6-fault-crash-points.test.ts` (crash at every handler step x every point, with power loss); in every fault run the **journal audit** (no two values per key in any honest journal ever written) and the **wire cross-check** (every honest signature seen on the network has a durable journal row) |
| S2 | **Lock rule.** A lock `(r, B)` is acquired only while handling a commit request with a valid PrepareQC for `(H, r, B)`; it never moves to a lower round or to another value at the same round; an honest validator prepare-votes a value other than its lock only with a valid PrepareQC justification at a round strictly above its lock round (`SAFE-VOTE`). Nothing else unlocks. | spec §4, §7.2 | `consensus-v6-primitives.test.ts` (SAFE-VOTE); `f01-v6-consensus.test.ts` T2b, T4, T5; `f01-journal-v2.test.ts`; journal audit lock-regression check in every fault run; `crash-step`/`power-loss` runs that crash at the commit step and restart while locked |
| S3 | **No two conflicting blocks finalize at one height** (L1: at most one PrepareQC value per round; L2: after a commit at round r no QC for another value exists at a later round). | spec §7.3-7.5, uses S-Q, S1, S2 only | `consensus-v6-model.test.ts` T9 (randomized schedules) and T12 (mutations are detected); `f01-v6-consensus.test.ts` T7; wire-level check for conflicting commit certificates and per-height comparison of every honest finalized chain in every fault run |
| S4 | **Finality is verified, never trusted.** Every node and light client checks `q` distinct commit votes for `(H, commitRound, hash)` under `validatorsAt(H)`, all from one round, an empty legacy round certificate, and the v6 block envelope. | spec §7.5 | `f01-v6-boundary.test.ts` (envelope); `f01-v6-transport.test.ts` (light client); `f01-v6-block-integrity.test.ts` |
| S5 | **Prefix consistency.** Every honest finalized chain is hash-linked and agrees with every other honest chain at every common height. | follows from S3 and S4 | per-node hash-link and per-height agreement check in every fault run |
| S6 | **One protocol per height, no fallback after activation.** Heights below the activation height use legacy rows and certificates, heights at or above it use v6 only; a v6 node refuses legacy-format blocks, legacy attest/skip requests and legacy journal rows at v6 heights; an old binary refuses v2 journal rows (downgrade fails closed). | spec §10, §12 | `f01-v6-boundary.test.ts` T11; `f01-journal-v2.test.ts` T10; `v6-fault-rollback.test.ts`; scenario `upgrade-v5-v6` (late nodes cross the boundary by block sync; no v2 row below and no legacy row at or above the activation height; every block at or above it is a v6 block). **Open:** a quorum-approved governance `protocol_upgrade` back to a legacy version is currently accepted after activation (section 6; fix proposed in PR #966) |
| S7 | **Supply invariant under faults.** Consensus faults never change the supply rule: total supply equals the initial supply minus burned transfer fees, never more. | fixed-supply design (#947) | supply check in every fault run (random transfers are submitted during the faults); tokenomics tests from #947/#950 |

### 2.2 Liveness

| ID | Obligation | Argument | Exercised by |
|---|---|---|---|
| L1 | **The leader learns the highest honest lock.** A round `r > 0` leader proposes only with a timeout certificate (TC) of `q` timeouts for `r - 1` and must re-propose the block of the highest QC reported in it (`justifyRound == max highQCRound`). Every honest highQC round is at least its lock round (the QC file is written before the lock row), so the proposal passes SAFE-VOTE everywhere. | spec §5, §8.2 | `consensus-v6-primitives.test.ts` (TC validation, leader obligation); `f01-v6-consensus.test.ts` T2, T2b, T3; any fault run whose post-GST bound holds after crashes while locked |
| L2 | **Bounded round changes after GST.** From the first round whose leader starts after GST (on the grid of the current tip), the pending height finalizes within `f_faulty + 1` rounds, because leaders rotate and at most `f_faulty` of any consecutive leaders are faulty. | spec §8.3 | every fault run asserts `commitRound <= R_h + f_faulty` for each height after GST when at most `f` validators are faulty; `f01-v6-chaos.test.ts` (T6 and the chaos smoke); `f01-v6-scheduler.test.ts` T13 |
| L3 | **Clock skew within the guard does not stop progress.** | spec §8.4 | `f01-v6-consensus.test.ts` T8; `f01-v6-chaos.test.ts` `clock-skew` |
| L4 | **Recovery.** A restarted or lagging validator catches up by block sync and takes part again; consensus-state files are liveness aids only (a lost QC file costs liveness, never safety). | spec §6.4, §9 | scenarios `prolonged-outage-sync`, `crash-step`, `power-loss` (`state-rename-lost` rolls a QC or proposal file back), `disconnect-reconnect`, `upgrade-v5-v6`. Snapshot-based recovery: `v6-fault-state-sync.test.ts`, marked todo until the NEW-R1 fix (PR #963) is merged; it passes on that branch |
| L5 | **Small sets.** With n = 2 (f = 0) any unavailable validator stops progress; v6 must resume automatically once it is back. | spec §7.6 | `v6-fault-n2-n7.test.ts` (n = 2 runs of crash, power loss, flapping partitions, delays and the upgrade) |

## 3. Journal and storage durability assumptions

1. `signing-journal.ndjson` is append-only. Each reservation is one
   `write` followed by `fsync`; the signature is computed only after the
   `fsync` returned. The lock and commit rows of a commit are written by one
   `write` and one `fsync`.
2. A power loss can drop or tear the unsynced tail. On reopen an unterminated,
   unparsable final record is dropped as never acknowledged; when it follows a
   lock row, the lock row is dropped with it (F-10). A complete final row that
   only lost its newline is kept. A complete lock row with no commit byte after
   it makes the journal fail-stop ("Torn protocol v6 lock/commit pair", spec
   §9.1). That is safe but needs operator action (section 6, item 2; fix
   proposed in PR #967).
3. Consensus-state files (`consensus-state/H-*`) are written to a temporary
   file, fsynced, renamed and the directory fsynced. A crash can leave a stray
   temporary file (ignored, pruned after finality) or, after a power loss, the
   previous version of the file. These files are never safety state.
4. The journal is protected by an exclusive OS-level lease: one writer per data
   directory.
5. Disks must not lie about `fsync`. Write caches without power-loss protection
   that acknowledge `fsync` early break S1; this is not testable in software.

## 4. Operator rules (violating one makes the validator faulty)

1. **Never restore a validator from an old disk, volume or VM snapshot, and
   never copy a data directory to start a second instance.** A restored
   directory has forgotten journal rows and locks, so the validator can sign a
   conflicting vote (shown by the negative control in
   `v6-fault-rollback.test.ts`). A validator that has been restored counts as
   faulty for the bound `f`. To recover a lost machine, start from an empty
   data directory with the same key only after the heights it may have signed
   are finalized, or rotate the key through governance.
2. Never hand-edit or truncate the signing journal or `consensus-state/`.
3. Never run two processes with the same validator key.
4. Keep clocks synchronized well within the 2 s timeout guard.
5. Use storage whose `fsync` is honest (section 3, item 5).
6. Networks that claim crash tolerance need n >= 4.

## 5. Test map and how to run

| File | What it covers | Cost |
|---|---|---|
| `l1/test/support/v6-fault.ts` | harness: crash/power-loss injector, journal audit, network faults, Byzantine voters, scenario runner and invariant checks | - |
| `l1/test/v6-fault-crash-points.test.ts` | every handler step (block-proposal, proposal, prepare, commit, timeout) x every crash point (consensus-state before rename, rename lost by power loss, journal write not synced with bytes surviving, lost or torn, journal synced, after the signature), n = 4; torn lock+commit appends | per PR |
| `l1/test/v6-fault-scenarios.test.ts` | all ten scenarios at n = 4, one seed | per PR |
| `l1/test/v6-fault-n2-n7.test.ts` | n = 2 functional runs and n = 7 Byzantine, combined and outage runs | per PR |
| `l1/test/v6-fault-rollback.test.ts` | rollback refusal at v6 heights; operator rule negative control | per PR |
| `l1/test/v6-fault-harness-selftest.test.ts` | the invariant checks catch injected mutations | per PR |
| `l1/test/v6-fault-state-sync.test.ts` | outage then anchored v6 snapshot install (todo until PR #963) | per PR (todo) |
| `l1/test/v6-fault-seeds.test.ts` | seed sweep, skipped unless `ZYRON_V6_FAULT_SEEDS` is set | opt-in |

Scenarios: `crash-step`, `power-loss`, `partition-flapping` (symmetric and
asymmetric partitions changing every 0.5-5 s), `delay-reorder-duplicate`
(late delivery after the leader gave up, duplicates, replay of old prepare and
commit requests), `disconnect-reconnect`, `prolonged-outage-sync` (up to f
validators down for about 20 heights, then block sync), `byzantine-f` (f
validators equivocate as leaders and sign every prepare/commit as voters),
`long-run` (about 40 heights under light faults), `upgrade-v5-v6` (v5 -> v6
activation with late nodes), `combined`.

Seed sweep:

```
cd l1 && npm run build
ZYRON_V6_FAULT_SEEDS=200 ZYRON_V6_FAULT_N=4,7 ZYRON_V6_FAULT_SHARD=0/4 \
  ZYRON_V6_FAULT_OUT=/tmp/v6-fault.jsonl node --test dist/test/v6-fault-seeds.test.js
```

Every random choice derives from `(scenario, n, seed)`; a failing run is
reproduced by running the same triple again.

## 6. Open items found by this work

1. **Governance downgrade after activation (open).** A `protocol_upgrade` with
   `q` approvals to a legacy version (for example 5) is admitted to the mempool,
   included in a v6 block and scheduled, so the chain would return to the
   legacy single-phase consensus (and its F-01 split) at the activation height.
   The design says rollback is possible only before activation. Requires a
   governance quorum, so it is not exploitable by a minority, but it is not
   refused. Triage: confirmed defect, Medium. Fix proposed in PR #966 (refuse
   any version decrease once v6 is scheduled, in admission, block validation
   and checkpoint schedules); awaiting owner approval.
2. **Lock row without commit row after power loss (observation).** If a power
   loss persists exactly the lock row of an unacknowledged lock+commit append,
   the journal refuses to open forever, while one more byte (a partial commit
   row) is dropped and recovers. Safe either way (no signature was released),
   but the first case leaves the validator down until an operator acts, and the
   runbook forbids editing journals. Spec §9.1 asks for fail-stop; F-10
   recovers the neighbouring case. Triage: confirmed defect, Low (safe
   fail-stop, liveness only, low likelihood). Fix proposed in PR #967 (keep the
   lock and complete the pair with its commit reservation); awaiting owner
   approval. The crash-point test in this suite accepts both behaviours.

## 7. Limits (what these tests do not show)

- They are not a proof. Seeds are finite, schedules come from one generator
  family, and the TLA+-style model in `consensus-v6-model.test.ts` is a
  separate abstraction.
- One process, virtual time, in-memory transport. Real HTTP/libp2p transport
  is only covered by `f01-v6-transport.test.ts`; real devnet runs by
  `devnet:check:v6`.
- Power loss is simulated by truncating or restoring files at the moments a
  real crash could happen. Disk firmware behaviour, reordered writes inside
  synced data and lying `fsync` are not modelled.
- The Byzantine model is: equivocating leaders (one twin per side), voters that
  sign every prepare/commit request and hide their highQC, replayed old
  requests. Adaptive adversaries, forged-certificate floods and resource
  exhaustion are covered elsewhere (T7, F-11, P1-06) or not at all.
- Liveness is asserted only after all transient faults heal (GST) with at most
  `f` validators faulty; no fault is injected after GST.
- Mixed versions are modelled as late nodes running the same binary. Old
  binaries are covered by the T10 downgrade guard and the earlier F-01
  old-binary activation check, not by this suite.
- Remote signers (P0-09) and real clock steps are out of scope.
- Results are AI-generated engineering evidence, not an independent audit.
