# Protocol v6 consensus specification: locked two-phase BFT with timeout certificates

> **Document status.** This is the design specification implemented by PR #945 (`fix(consensus): protocol v6 locked two-phase round change (F-01)`, merged as `6607dbf`). It was written before implementation (the original title was "F-01 Consensus Design Specification") and is committed unchanged in its technical content, so file and line references point at the pre-implementation code baseline named below, not at current `main`. Source code comments refer to this document by its working name `F01_CONSENSUS_DESIGN.md`.
>
> **Later fixes (merged 2026-10-12).** The following follow-up PRs refine or correct v6 behaviour. They are merged on `main`; this specification's normative text has not been rewritten for them, so where they differ the merged code and its tests apply:
> - #963 (merged `c81ec66`): trusted snapshot/checkpoint verification of v6 tips with the commit certificate, and write-verify-swap recovery checkpoints (finding NEW-R1).
> - #966 (merged `f8f46b5`): protocol downgrades are refused once v6 is scheduled. The rollback rule in section 12 item 4 ("cancel or replace the upgrade through governance before A") therefore no longer holds: a scheduled v6 activation cannot be cancelled through governance.
> - #967 (merged `d1bdc17`): a lone trailing v6 lock row left by a power loss is kept and completed with its commit reservation instead of the fail-stop that section 9.1 specifies for a torn lock+commit pair, but only when the replayed history is consistent with a commit append (no timeout at or above that round, no later vote, any own prepare at that round is for the same block). An inconsistent lone lock, or a lock row followed by any other row, still fails closed (`f01-journal-v2.test.ts`, `v6-journal-lock-row-only.test.ts`).
> - #968 (merged `cd9729b`): binding of the trusted snapshot tip body to `header.transactionRoot` (a pre-existing gap, not specific to v6).
>
> Where this specification and merged code disagree, the code and its tests are authoritative and the difference should be reported. Implementation-level safety obligations are tracked in [`../V6_SAFETY_PROOF_OBLIGATIONS.md`](../V6_SAFETY_PROOF_OBLIGATIONS.md) and operator procedures in [`../V6_OPERATOR_GUIDE.md`](../V6_OPERATOR_GUIDE.md). Activation of v6 on any network is a separate owner decision.

# F-01 Consensus Design Specification: Locked Two-Phase BFT with Round-Change Certificates (protocol v6)

- **Status (at writing):** design only, written before implementation and reviewed before PR #945. See the document status note above.
- **Finding:** F-01: a split attest/skip vote in one round permanently halts the chain (internal security audit report, finding F-01 and its deep-dive section, plus the addendum dated 2026-10-04; the report is not part of this repository).
- **Code baseline:** branch `fix/f03-skip-vote-protocol-version` at `8a07c0c` (F-03 fix, rebased on `origin/main` `a366d78`, which has no L1 changes after `bdc1e9e`). Line numbers below are for that head. `file:function:line` gives the function's declaration line or the cited statement.
- **Characterization evidence:** scratch proof-of-concept runs (in-process, against the compiled production modules, with real fsynced signing journals, loopback only), `devnet:check` run summaries and saved validator journals. These working files are not committed to the repository; the reproducible characterization is the test plan in section 11.
- **Notation:** n = validator count at height H (`validatorsAt(H)`). q = `floor(2n/3)+1` (`block.ts:validatorQuorumSize:195`). f = the number of Byzantine validators. QC = q valid signatures from distinct validators of `validatorsAt(H)` over the same payload.
- **Section map:** the ten mandatory sections are §3 to §12 (state machine, locking, round change, journal, safety, liveness, persistence, compatibility, tests, migration). §2 is the model comparison. §13 maps the design onto the code. §14 explains the devnet finding. §15 lists contradictions with earlier conclusions. §16 holds the end sections.

---

## 0. Executive summary

**Root cause (confirmed in code).** Today one signature does two jobs: a validator's attestation of block B at (H, r) is both its vote for B and its commit vote for B. The only way out of round r is a round-skip vote, and the signing journal makes attest and skip mutually exclusive per `height:round` (`storage.ts:SigningJournal.reserveChoice:953`, key at :966, conflict thrown at :970). A skip for round r ≥ 1 also requires a skip QC for r-1 (`node-base.ts:NodeService.requestSkipVote:408`, check at :426-437). If round r ends with k attestations where `n-q < k < q`, neither a finality QC nor a skip QC can ever form for r, and every later round depends on that missing skip QC. The halt is permanent and survives restarts, because the journal is durable.

**Recommendation.** Keep the leader-driven, pull-based structure (the round leader collects votes over HTTP or libp2p request/response) and add a separate **prepare phase** before the existing attestation, which then becomes the commit vote. This is a non-pipelined two-phase protocol in the HotStuff family (leader-aggregated QCs, highQC, timeout certificate, pacemaker), using Tendermint's lock/unlock-on-higher-QC rule. The skip vote is replaced by a **timeout vote**. A validator can always sign one timeout per round, even after voting in that round. Each timeout vote reports the signer's highest prepare QC, and the round-r+1 leader must re-propose the value of the highest prepare QC in the round-change (timeout) certificate. Finality stays a single-shot certificate of q commit signatures embedded in the block.

**Second phase: required.** With a single voting phase (attestation = commit) and n = 3f+1, carrying the "highest attested value" across rounds cannot be both safe and live against one equivocating proposer. §5.4 gives a concrete n=4, f=1 counterexample, and the general result is the n ≥ 5f+1 lower bound for two-step BFT (Martin and Alvisi, "Fast Byzantine Consensus", 2006). The audit's alternative fix ("let round-r+1 timeouts carry the highest attested proposal forward") is therefore **not sufficient on its own** (§15).

**Devnet finding (new).** The 2-validator `npm run devnet:check` enters the F-01 split without any fault injection. Two facts combine. First, the validator loop ticks every `BLOCK_INTERVAL_MS` = 30 s (`cli.ts:500-506`), which equals `ROUND_WINDOW_MS` = 30 s (`node-base.ts:63-64`), so each validator acts once per round window at a fixed, start-up-dependent offset. Second, for n = 2 the proposer's own reservation already gives k = 1 (`n-q = 0 < 1 < 2 = q`). §14 describes the two trigger paths, and the audit addendum records them. The scratch run reproduces both deterministically against production code.

---

## 1. Current protocol as implemented (mapping baseline)

### 1.1 Constants and scheduling
| Element | Location | Value / behaviour |
|---|---|---|
| `BLOCK_INTERVAL_MS` | `l1/src/node-base.ts:63` | 30 000 ms. A height is first proposable 30 s after the tip timestamp. |
| `ROUND_WINDOW_MS` | `l1/src/node-base.ts:64` | 30 000 ms. Every round has the same fixed length (no timeout growth). |
| `MAX_VALIDATOR_CLOCK_ROLLBACK_MS` | `l1/src/node-base.ts:65` | 1 000 ms. A larger backwards clock step fail-stops signing (`NodeService.assertValidatorClock:480-489`). |
| `MAX_CONSENSUS_ROUND_CATCHUP` | `l1/src/node.ts:36` | 64. The producer returns `null` above this (F-02). |
| `HTTP_CONSENSUS_TIMEOUT_MS` | `l1/src/node.ts:31` | 8 000 ms collection deadline (`collectHttpConsensusPeers:192`). |
| `NATIVE_CONSENSUS_COLLECTION_TIMEOUT_MS` | `l1/src/p2p-consensus.ts:23` | 8 000 ms. |
| Validator tick | `l1/src/cli.ts:500-506` (`schedule` = `setInterval`, `:460-464`) | `produceFinalizedBlock` every **30 s**. The phase is fixed by process start time. |
| Peer sync tick | `l1/src/cli.ts:508-517` | `max(5 s, BLOCK_INTERVAL_MS/3)` = 10 s. |
| Round derivation | `l1/src/node.ts:produceFinalizedBlock:316-319` | `round = floor((now - tip.timestampMs - BLOCK_INTERVAL_MS) / ROUND_WINDOW_MS)`. This is a purely wall-clock pacemaker. |
| Proposer | `l1/src/block.ts:expectedValidator:185-193` | `validators[((H-1) mod n + r mod n) mod n]` (round-robin). |
| Quorum | `l1/src/block.ts:validatorQuorumSize:195-198` | `floor(2n/3)+1`. |

### 1.2 Current state machine (per height H = tip+1)
1. **Wait.** Every tick, `produceFinalizedBlock` (`node.ts:306`) returns unless `elapsed ≥ BLOCK_INTERVAL_MS` and this validator is `expectedValidator(H, round)` (`node.ts:317-328`). Non-proposers never act on their own. They only answer requests.
2. **Skip collection (round r > 0).** For each `s = 0..r-1`, the producer requests its own `NodeService.requestSkipVote(H, s, prevCert)` (`node.ts:336`) and the peers' `requestRoundSkips` (`node.ts:344`; HTTP `PeerClient.requestRoundSkips` `node.ts:266`, native `NativeConsensusPeerClient.requestRoundSkips` `p2p-consensus.ts:212`). It verifies them under `protocolVersionAt(H)` (F-03 fix, `node.ts:326,348-366`) and needs a skip QC for every s (`node.ts:369-387`). Signing side: `requestSkipVote` enforces `now ≥ tip.ts + BI + (s+1)·RW` (`node-base.ts:421-422`) and a QC for s-1 when s > 0 (`:426-437`), reserves `skip(H,s)=tipHash` (`:442`), and signs `roundSkipPayload` (`block.ts:119`).
3. **Propose.** `chain.prepareBlock` (`chain.ts:361`) sets `header.round = r`, `timestampMs = consensusNowMs`, and `roundCertificate` = the skip QC for r-1 (`node.ts:393-398`). `NodeService.signPreparedProposal` (`node-base.ts:394`) reserves **`attest(H,r)=blockHash`** (`:400`) and then signs the header.
4. **Attest.** The proposer self-attests (`node.ts:403-407`), and peers are asked through `requestAttestations` (`node.ts:248`; `p2p-consensus.ts:198`). Each peer runs `NodeService.attestProposal` (`node-base.ts:370`): `chain.validateProposal` (`chain.ts:443-450`; there is **no round-deadline check**), then reserves `attest(H,r)` (`:380`), then signs `attestationPayload` = `{chainId,height,blockHash}` (`block.ts:177-183`).
5. **Commit / finality.** With ≥ q valid attestations (`node.ts:410-418`; `block.ts:validateAttestationQuorum:385`), the producer runs `acceptFinalizedBlock` (`node-base.ts:463`) and `broadcastBlock`. Peers accept through `POST /block` (`node-base.ts:733`) or the native `block` kind (`p2p-consensus.ts:152-154`). After the commit, `compactThrough(height)` drops journal rows ≤ H (`storage.ts:888`).

### 1.3 Current certificates and signature domains
| Object | Payload | Domain (v ≥ 3; v1/v2 sign the raw payload) | Carried in |
|---|---|---|---|
| Block proposal | `BlockHeader` {version, chainId, height, round, previousHash, timestampMs, transactionRoot, stateRoot, proposer} | `zyronchain/block-proposal/v1` (`block.ts:createSignedBlock:66-71`; `validator-signer.ts:validatorSigningDomain:120-126`) | `block.signature` |
| Finality attestation | `{chainId, height, blockHash}` (no round) | `zyronchain/finality-attestation/v1` | `block.attestations[]` |
| Round skip | `{validator, publicKey, chainId, height, round, previousHash}` | `zyronchain/round-skip/v1` | `block.roundCertificate[]`: only the QC for `header.round-1` (`block.ts:validateRoundCertificate:252-266`) |

Domain separation is `sign({domain, payload})` (`crypto.ts:signCanonicalDomain:36`), selected when `protocolVersion ≥ 3` (`block.ts:signForProtocol:435`, `verifyForProtocol:446`). `blockHash = sha256(canonicalJson(header))` (`block.ts:blockHash:25`). **`roundCertificate` and `attestations` live outside the header**, so neither the block hash nor the proposer signature covers them (`block.ts:createUnsignedBlock:98-106`).

### 1.4 Current signing journal
`SigningJournal` (`storage.ts:794`) stores one NDJSON line per reservation, `{height, round, kind: "attest"|"skip", value}`, at most 1 024 bytes (`storage.ts:20`). The key is `"${height}:${round}"` (`reserveChoice:966`). Reserving the same value again is idempotent (`:969`), and a different value throws `Conflicting validator action prevented for consensus round` (`:970`). The line is appended and fsynced **before** the signature is produced (`:972-982`). Any I/O error fail-stops the journal (`:983-990`). `open` (`:803-854`) replays all lines, rejects unknown kinds and non-hex values (`:817-821`) and conflicting history (`:825`), and holds an exclusive SQLite lease (`acquireSigningJournalLease:995`). There is no record version field. Extra keys are tolerated, unknown kinds are fatal.

### 1.5 Governance-activated protocol versions
`SUPPORTED_PROTOCOL_VERSIONS = {1,2,3,5}` (`chain.ts:64`). v4 is not supported by this binary. `protocolVersionAt(H)` (`chain.ts:312-323`) follows the schedule written by `protocol_upgrade` transactions (`chain.ts:recordGovernanceUpdates:657-666`). These require `activationHeight ≥ inclusionHeight + MIN_PROTOCOL_UPDATE_DELAY` (100, `chain.ts:63`), strictly increasing activations, and q current-validator approvals (`chain.ts:validateProtocolUpgradeAuthorization:780`). Versions 1..65535 are accepted syntactically (`transaction.ts:333`). A binary that meets an unsupported version fail-stops (`chain.ts:assertSupportedProtocolVersion:746`). `validatorsAt(H)` (`chain.ts:299-310`) is static per height, and set changes activate ≥ 100 blocks later (`chain.ts:62`).

---

## 2. Model comparison and choice

### 2.1 Candidates
| Property | Current Zyron | Tendermint-style | HotStuff-style (2-phase; HotStuff-2 / Jolteon family) | Casper FFG-style |
|---|---|---|---|---|
| Vote phases per round | 1 (attest = commit) | 2 (prevote, precommit) | 2 (prepare → lock, commit) | justification/finalization links over checkpoints |
| Message pattern | leader pulls votes (request/response) | all-to-all gossip; every node counts votes | leader aggregates votes into QCs (linear) | gossip on top of a fork-choice chain |
| Lock | none; per-slot exclusivity only | lock on polka (+2/3 prevotes) at precommit; unlock on a higher-round polka (POLRound) | lock on the QC voted for; highQC carried in timeouts | none; slashing rules (double/surround vote) |
| View change | chain of skip QCs; skip exclusive with attest | timeout → next round; proposer re-proposes validValue with POLRound | timeout votes carry highQC → TC; leader extends max highQC (pacemaker) | not a view change |
| Requires gossip of votes | no | **yes** (a validator must observe polkas) | no (QCs travel with proposals and commit requests) | yes |
| Fit with pull-based endpoints | native | poor (gossip layer or N² pulls) | **native** (leader pulls votes, forwards QC) | poor |
| Finality artifact | q attestations in block | +2/3 precommits of one round | commit QC | finalized checkpoint |
| Pipelining | none | none | chained variants pipeline QCs across blocks | epochs |

### 2.2 Evaluation against Zyron's architecture
- **Small, static validator sets.** `MAX_VALIDATOR_COUNT` = 100 (`block.ts:21`), and sets change only after a ≥ 100-block delay. QCs of ≤ 100 signatures fit the existing frame budget (`p2p-consensus.ts:15`, 2.5 MB). Scale rules out neither model.
- **Pull-based HTTP and libp2p request/response.** Votes are never broadcast. The round leader pulls them (`requestAttestations`, `requestRoundSkips`), and peers do not gossip attestations to each other. In Tendermint a locked validator unlocks only after it has *seen* a higher-round polka. Without gossip, that evidence has to ride inside the proposal anyway, which is exactly HotStuff's "justify with a QC". **Leader aggregation maps 1:1 onto the existing endpoints.**
- **Single-shot finality embedded in each block and checked by light clients** (`light-client.ts:verifyNextFinalizedHeader:82`; `independent-light-client/verify_vector.py`). Chained HotStuff would finalize block h only through QCs in h+1 and h+2, which breaks per-block instant finality and the light-client proof format. The **non-pipelined** form (both phases inside one height) preserves "block H carries its own finality certificate".
- **Round-change evidence in blocks.** It is not in the header today (§1.3). Under the new design it is no longer needed for finality validity and travels in consensus messages instead (§5.1).
- **Per-slot SigningJournal reservations.** Both models need "at most one signature per (height, round, step)". The journal extends naturally with a step dimension (§6).
- **Governance-activated versions.** Changing signature domains, certificate format or validity rules is consensus-breaking and must switch at one height through `protocol_upgrade` (§10).

### 2.3 Decision and adaptation
The choice is a **locked two-phase protocol with leader aggregation (HotStuff family, non-chained) that uses Tendermint's lock rule.** Each rule is adapted for a stated reason:
1. **Leader aggregation** (HotStuff). It reuses the pull-based clients and keeps O(n) messages per phase.
2. **The prepare QC is the lock evidence.** It is needed for safety with n = 3f+1 (§5.4).
3. **Unlock only for a proposal justified by a strictly higher-round prepare QC** (Tendermint `POLRound > lockedRound`). The QC travels inside the proposal, so no gossip layer is needed.
4. **The timeout certificate carries each signer's highQC** (HotStuff/Jolteon) and replaces the skip QC. A timeout is **never exclusive** with an earlier prepare or commit in the same round. That one property removes the F-01 deadlock.
5. **Same-round, single-height commit certificate** (Tendermint Commit). Finality is q commit votes for (H, r, B), embedded in the block as today.
6. **Deterministic clock-derived schedule with growing round durations and TC-driven early entry (pacemaker).** It keeps "the round is computable from the tip timestamp", growth gives eventual synchrony after GST, and event-driven timers remove the tick/round coincidence (§3.3, §8.6).

**Rejected alternatives.** Casper FFG is a finality gadget over a fork-choice chain and needs gossip and slashing that Zyron does not have. Patching the current one-phase model is ruled out by §5.4.

---

## 3. Section 1: Consensus state machine (normative for v6)

### 3.1 Per-validator state for height H (reset when H finalizes)
| Variable | Meaning | Persisted |
|---|---|---|
| `H` | `chain.height + 1` | derived from the finalized log |
| `round` | lowest round v may still vote in = `max(highestOwnTimeout + 1, highestValidTC + 1, highest round with an own prepare/commit row)`. The clock does not move it: `clockRound(now)` (§3.3) only decides when v leads and when it may time out | derived from journal rows and TCs seen |
| `step` | `PROPOSE` / `PREPARE` / `COMMIT` / `TIMED_OUT` within `round` | derived from journal rows of `round` |
| `lock` | `(lockedRound, lockedHash)` (+ `lockedQC`) or ⊥ | **yes**: journal `lock` row (+ QC file) |
| `highQC` | highest-round valid PrepareQC seen for H (≥ lock) | yes, best effort (QC file); liveness only |
| `validBlock` | block whose hash = `highQC.blockHash` (needed to re-propose) | yes, with highQC |
| `pendingProposal(H,r)` | leader only: the exact signed Proposal and Block for (H,r) | **yes**: proposal file (same-round retries) |

### 3.2 Messages (v6). All domain-separated and bound to chainId, H, r.
| Message | Signed payload | Domain | Signer | Transport |
|---|---|---|---|---|
| `Block` (object unchanged) | `BlockHeader`, where `header.round` = **origin round** r₀ (round in which the block was built) | `zyronchain/block-proposal/v1` (unchanged) | `expectedValidator(H, r₀)` | inside `prepare` |
| `Proposal` | `{chainId, height, round, blockHash, justifyRound}` (`justifyRound` = round of attached PrepareQC, or -1) | `zyronchain/consensus-proposal/v1` | `expectedValidator(H, round)` | leader → validators, `prepare` request |
| `PrepareVote` | `{chainId, height, round, blockHash}` | `zyronchain/prepare-vote/v1` | validator | `prepare` response |
| `PrepareQC` | ≥ q distinct PrepareVote signatures with identical (H, r, blockHash) | n/a (aggregate) | n/a | `commit` request, timeout responses, proposals |
| `CommitVote` | `{chainId, height, round, blockHash}` | `zyronchain/commit-vote/v1` | validator | `commit` response |
| Finality certificate | ≥ q distinct CommitVotes, identical (H, r, blockHash) | n/a | n/a | `block.attestations` + new `block.commitRound = r` |
| `TimeoutVote` | `{chainId, height, round, highQCRound, highQCHash}` (`-1` / 64 zeros if none) | `zyronchain/round-timeout/v1` | validator | `timeout` response, together with the full highQC object as an unsigned carrier |
| `TimeoutCertificate` TC(H,r) | ≥ q distinct TimeoutVotes for (H,r) + the PrepareQC whose round is the maximum reported `highQCRound` | n/a | n/a | next round's `prepare` request |

All domain strings satisfy `crypto.ts:assertSigningDomain:74-77` (`^zyronchain/[a-z0-9][a-z0-9._/-]{0,95}$`). Each type has a distinct payload shape **and** a distinct domain, so no signature can verify as another type. PrepareVote and CommitVote share a payload shape and are separated only by their domains, which is sufficient because v6 ≥ 3 always signs with domains.

### 3.3 Round schedule (pacemaker)
- `roundDuration(r) = min(ROUND_BASE_MS + r·ROUND_STEP_MS, ROUND_MAX_MS)`. Suggested values: `ROUND_BASE_MS` = 30 000 (today's window), `ROUND_STEP_MS` = 5 000, `ROUND_MAX_MS` = 120 000. These are owner decisions (§16.9).
- `roundStart(H,0) = tip.timestampMs + BLOCK_INTERVAL_MS`, and `roundStart(H,r+1) = roundStart(H,r) + roundDuration(r)`. Every node computes the same schedule from the finalized tip, as today (`node.ts:316-318`), but with a non-constant window.
- `clockRound(now)` = the largest r with `roundStart(H,r) ≤ now`.
- **Early entry:** a valid TC(H,r) lifts `v.round` to r+1, and a leader of r+1 may propose as soon as it holds TC(H,r), without waiting for `roundStart(H,r+1)`.
- **Event-driven timers (no fixed-period consensus tick):** the leader acts at `roundStart(H,r) + jitter(0..250 ms)`. Validators become willing to time out at `roundEnd(H,r) - TIMEOUT_GUARD_MS`. Incoming messages trigger handlers immediately. The leader retries pulls every ≤ 1 s inside its round. Any fallback poll must be ≤ `ROUND_BASE_MS/10`. The fixed 30 s `setInterval` (`cli.ts:500-506`) must not drive consensus (§8.6).

### 3.4 Transitions for validator v at (H, r)
```
PROPOSE  (v = L(H,r) = expectedValidator(validatorsAt(H), H, r); at roundStart(H,r) or on TC(H,r-1)):
  if journal has proposal(H,r): re-send stored pendingProposal unchanged; never build another   # same-round retry
  else:
    if r == 0:  M := highQC (normally ⊥)
    else:       pull `timeout(H,r-1)` from ALL validators (incl. self); verify each vote and its carried QC;
                wait until ≥ q valid AND (all answered OR collection deadline); M := verified QC of max round
    B := M ? validBlock(M) : chain.prepareBlock(..., round: r)    # fresh block has header.round = r
    reserve proposal(H,r)=sha256(Proposal); (fresh B: reserve block-proposal(H,r)=B.hash, sign header)
    persist pendingProposal; sign Proposal{H, r, B.hash, justifyRound: M?.round ?? -1}
    send `prepare` {Proposal, Block, justify: M, tc: TC(H,r-1) (r>0)} to all validators incl. self

PREPARE  (validator, on `prepare` for (H,r); r ≥ v.round, i.e. no timeout row for any r' ≥ r and no prepare/commit row above r):
  verify Proposal signature by L(H,r); chainId/H match; Block passes chain.validateProposal semantics (no finality);
         Block.header.proposer == expectedValidator(H, Block.header.round); Block.header.round ≤ r;
         if r > 0: TC(H,r-1) valid (§5.1) and justifyRound == max reported highQCRound in TC;
         if justify present: valid PrepareQC(H, justifyRound, Block.hash) with justifyRound < r
  SAFE-VOTE: lock == ⊥  OR  lock.hash == Block.hash  OR  justifyRound > lock.round
  reserve prepare(H,r)=Block.hash ; sign PrepareVote ; record validBlock/highQC if justify is higher ; respond

COMMIT   (leader holds q PrepareVotes ⇒ PrepareQC(H,r,B); sends `commit` {PrepareQC, Block} to all validators):
  validator: verify QC; r ≥ v.round (as for PREPARE); own prepare(H,r) row, if any, == B
  persist QC file (lockedQC, highQC, validBlock) ; append_atomic [lock(H)={r,B}, commit(H,r)=B] + fsync ;
  sign CommitVote ; respond

FINALIZE (leader holds q CommitVotes for (H,r,B)):
  block := B with attestations := CommitVotes, commitRound := r, roundCertificate := [] ;
  acceptFinalizedBlock ; broadcast `/block` (and native `block`)
  any node: valid finalized block for H ⇒ commit, compactThrough(H), delete consensus-state ≤ H, reset state

TIMEOUT  (on `timeout` request for (H,r), or locally; requires now ≥ roundEnd(H,r) - TIMEOUT_GUARD_MS and H not final.
          ALWAYS permitted once per (H,r), whatever prepare/commit rows exist for (H,r)):
  payload.highQC := (highQC.round, highQC.hash) or (-1, 0^64)
  reserve timeout(H,r)=sha256(payload)   # identical payload on retries ⇒ identical signature
  sign TimeoutVote ; respond {vote, highQC object}
  thereafter: no proposal/prepare/commit for any round ≤ r at height H
```
`TIMEOUT_GUARD_MS` (suggested 2 000 ms) lets a leader whose clock is a little ahead collect timeouts without being refused by peers whose clocks lag slightly. It must be ≥ the assumed clock-skew bound ε (§8.4).

### 3.5 Timers and message flow (happy path, one round)
Let `t = roundStart(H,r)`. The leader sends `prepare`, holds a PrepareQC by about t + 2δ and sends `commit`, then holds the finality certificate by about t + 4δ, where δ = one-way latency + processing, including fsync. It finalizes and broadcasts. If no certificate exists by `roundEnd - TIMEOUT_GUARD_MS`, validators become willing to sign a timeout. The leader of r+1 pulls timeouts at `roundStart(H,r+1)` and proposes.

---

## 4. Section 2: Locking rules

1. **Acquire.** A validator acquires lock (r, B) **only** while handling a `commit` request that carries a valid PrepareQC(H, r, B), and only if it has no timeout row for any r' ≥ r. The `lock` row (and the QC file) are durable **before** the CommitVote signature is released (§9.2).
2. **Retain.** The lock survives rounds and restarts until H is finalized. Its value is the block hash and its round is the QC round.
3. **Replace (monotonic).** Only rule 1 with a strictly higher round r' > r can replace a lock. Replacement at the same round cannot change the value (Lemma L1, §7.3). A lock never moves to a lower round (journal rule §6.2-5).
4. **Unlock evidence (exact).** A lock never prevents a prepare vote for a proposal at round r whose `justify` is a valid PrepareQC(H, jr, B') with `lock.round < jr < r`: q valid `zyronchain/prepare-vote/v1` signatures from distinct members of `validatorsAt(H)` over `{chainId, height: H, round: jr, blockHash: B'}`. **Nothing else unlocks.** That includes a single attestation or vote, a timeout vote or TC without the matching QC, a finality certificate of another height, and an operator action. Unlocking is implicit: the validator prepare-votes B', and its lock row changes only when rule 1 fires again.
5. **highQC versus lock.** `highQC` can exceed `lock`, for example when a QC was seen in a `commit` request after the validator had already timed out the round. highQC is reported in timeouts (liveness). Only the lock gates prepare votes (safety).
6. **Leader obligation.** At r > 0 the leader must propose the block of the maximum highQC in the TC it attaches. Validators check `justifyRound == max(TC.highQCRound)` and that the block hash equals the QC hash, so the block is byte-identical and cannot be rebuilt. This is a **liveness** rule. The safety proof (§7) does not use it.

---

## 5. Section 3: Round / view change

### 5.1 Timeout certificate: exact structure
```
TimeoutCertificate {
  chainId, height: H, round: r,
  votes: TimeoutVote[]   // ≥ q, distinct validators of validatorsAt(H); each exactly
      { validator, publicKey, chainId, height: H, round: r, highQCRound: int (-1 ≤ x ≤ r), highQCHash: hex32, signature }   // corrected in Phase 0, see note below
  highQC: PrepareQC | null   // REQUIRED iff max(votes[].highQCRound) ≥ 0; then highQC.round == that max and
                             // highQC.blockHash == highQCHash of every vote reporting that round
}
PrepareQC { chainId, height, round, blockHash, votes: { validator, publicKey, signature }[] }   // ≥ q distinct
```
- **Signatures and domain separation:** every TimeoutVote is signed under `zyronchain/round-timeout/v1` over `{chainId, height, round, highQCRound, highQCHash}`. The reported highQC is part of the signed payload, so nobody can strip or inflate a signer's report.
- **Validation** mirrors `block.ts:validateRoundSkipQuorum:268-290`. Exact keys, membership check (`address → publicKey` equality), duplicates rejected, size capped at `|validatorsAt(H)|`, count ≥ q, explicit protocol version (≥ 6). A vote with `highQCRound > r` is invalid. `highQC` is verified as a PrepareQC.
- **Phase 0 correction (2026-10-04, executable model):** the original text required `highQCRound < r` here. That contradicts §6.3 ("after `commit(H,r,B)`, `timeout(H,r)` is legal and reports `highQCRound ≥ r`") and T2b. A validator that locked at round r must report its round-r QC in `timeout(H,r)`. Otherwise the round-(r+1) leader cannot learn that lock, and every locked validator refuses the fresh proposal. In the T2b scripted schedule this halts the height for at least one extra round per occurrence. Randomized runs with the literal rule produced 35 bounded-finality violations in 50 000 schedules (all n = 7, b = 2; for example seeds 251, 1758, 3826, 8501) and no safety violations. The corrected rule `-1 ≤ highQCRound ≤ r` produced 0 violations in the same 50 000 schedules. Safety is unaffected because the reported QC is verified (§5.2), and a QC at round r still satisfies `justifyRound < r+1` (§3.4).
- **Size bound:** ≤ 100 votes × ~350 B plus one QC of ≤ 100 × ~200 B, about 55 kB. Today's skip **response** limits are 16 kB on both transports (native `NATIVE_CONSENSUS_RESPONSE_MAX_BYTES.skip`, `p2p-consensus.ts:36`; HTTP `MAX_HTTP_ROUND_SKIP_RESPONSE_BYTES`, `node.ts:35`). They are too small for timeout responses that carry a QC, so the new protocol needs its own per-kind limits (about 64 kB). The native skip **request** limit is 128 kB (`p2p-consensus.ts:29`) (§16.4).

### 5.2 Carrying the highest locked or prepared value forward
The leader of round r+1 pulls `timeout(H,r)` from **all** validators. Each response carries the signed vote **and** the full highQC object, and the leader verifies the QC before counting the vote. A vote whose claimed QC does not verify is discarded. M is the verified QC of maximum round among **all** responses received before the collection deadline, not just the first q. The TC contains ≥ q votes, including at least one vote reporting M. If M exists, the proposal re-proposes M's stored block (`validBlock`) with `justify = M`. Validators accept it under SAFE-VOTE, because M.round ≥ their lock round. If the rounds are equal, the values are equal (L1). If M is higher, the third disjunct applies.

### 5.3 No value has sufficient support
If every collected timeout reports `highQCRound = -1`, the leader may propose any valid fresh block with `header.round = r+1`. This is safe: honest validators that are locked but did not respond keep enforcing their locks, and those locks can only be released by a higher QC (§4.4). Safety therefore never depends on the leader seeing every lock. Liveness needs the leader to see the highest honest lock, which §8.2 provides after GST.

### 5.4 Why one voting phase is insufficient (decision on precommit)
Consider the one-phase variant: the attestation stays the commit vote, a skip or timeout may follow an attestation and carries the attested hash, and the next leader re-proposes the "highest attested" value. Take n = 4 (q = 3, f = 1), with v4 Byzantine and the round-0 leader:
1. v4 sends B to v1 and v2, and B' to v3. v1, v2 and v4 attest B, so **B is final** (3/3). v4 keeps the certificate private.
2. v3 attests B' (it saw only B').
3. The round-0 timeout quorum is {v1, v3, v4}: v1 reports B@0, v3 reports B'@0, v4 reports B'@0. v4's report is backed by a genuine proposal signature and its own attestation.
4. Both B and B' are "attested at round 0". Any deterministic choice rule (count, order, hash) can be steered to B'. If honest validators that attested B refuse B' (a lock backed by a single attestation), then B' can get at most {v3, v4}, and B can get at most {v1, v2} because v4 withholds and v3 refuses. That is a **permanent halt with one Byzantine node**, which is F-01 again. If instead they unlock on a report at a round ≥ their own, B' can gather v1, v2 and v3 and **finalize after B: a safety violation**.
A quorum of one-phase reports cannot tell "B had q votes" apart from "B' had one vote". The second phase makes lock evidence itself a quorum (a PrepareQC), and at most one value per round can have one (L1). This matches the known bound: deciding in two message steps (proposal plus one vote round) while tolerating f Byzantine faults requires n ≥ 5f+1 (Martin and Alvisi, 2006). Zyron's sets use q = floor(2n/3)+1 with f < n/3, below that bound, so **a second voting phase (prepare before the commit/attestation) is required**. §7 proves the chosen design safe.

### 5.5 Asymmetric partitions and healing
- **Safety** never depends on timing or delivery (§7). Every partition pattern is safe.
- **During a partition**, a side with fewer than q validators forms neither a QC nor a TC. Its validators time out locally (at most one timeout per round). Unlike today, these actions **cannot** block the other side or the healed network, because a timeout never conflicts with anything signed earlier.
- **After heal**, the first leader whose round begins after the heal pulls timeouts from everyone and so learns the maximum highQC across all sides. Every minority-side lock is either for the same value (and is re-proposed) or at a lower round (so M unlocks it). Two different locks at the same round are impossible. Validators that fell behind enter the current round through the TC attached to the proposal (early entry). Finalization follows within the bound of §8.3. Asymmetric reachability is handled because only the leader's reachability matters in a round: if the leader cannot reach q validators, the round fails and leadership rotates.

---

## 6. Section 4: Anti-equivocation journal rules

### 6.1 Persisted per (height, round, step)
| step | value | written when | idempotent re-sign |
|---|---|---|---|
| `block-proposal` | blockHash | before the origin header signature (fresh block only) | yes (signatures are deterministic, RFC 6979 via `crypto.ts`) |
| `proposal` | sha256 of canonical Proposal payload | before signing the Proposal | yes |
| `prepare` | blockHash | before signing PrepareVote | yes |
| `lock` | `{lockRound, blockHash}`, monotonic, one live value per height | in the same fsynced append as `commit` | n/a |
| `commit` | blockHash | after the `lock` row, before releasing CommitVote | yes |
| `timeout` | sha256 of canonical TimeoutVote payload (binds the reported highQC) | before signing TimeoutVote | yes. A different payload for the same (H,r) is refused, so a retried pull gets the identical vote |

### 6.2 Forbidden combinations (checked in the reserve path before any signature)
1. Two different values for the same (H, r, step). This generalises `reserveChoice:966-970` with a step dimension.
2. `proposal`, `prepare` or `commit` at (H, r) when a `timeout` row exists at (H, r') with r' ≥ r, or a `prepare`/`commit` row exists at a round > r.
3. `commit(H,r,B)` when `prepare(H,r)` exists with a value ≠ B. A `commit` **without** an own `prepare` is allowed (a validator that missed the `prepare` may commit on a valid QC, which proves q prepare votes).
4. `prepare(H,r,B)` that violates SAFE-VOTE against the persisted lock.
5. A `lock` row that lowers the lock round, or keeps the round with a different hash.
6. `proposal(H,r)` or `block-proposal(H,r)` by a validator other than `expectedValidator(H,r)`.
7. Any v6 row at height H while a **legacy** row (`attest`/`skip`) exists at height H, and vice versa. This is fail-closed and only reachable by operator error across the activation boundary (§12).

### 6.3 Timeout actions that stay legal after an earlier vote in the same round
- After `prepare(H,r,B)`: `timeout(H,r)` is **legal**. This is the essential change compared with today's exclusive skip.
- After `commit(H,r,B)` (locked): `timeout(H,r)` is **legal** and reports `highQCRound ≥ r`.
- After `timeout(H,r)`: nothing more in round r or below. Later rounds follow §6.2.
- There is no explicit nil prepare or nil commit. In the leader-driven design, a missing vote followed by a timeout plays that role.

### 6.4 Restart behaviour
On `open`, both legacy and v2 rows are replayed (§9.2). `lock` is restored from its row, and `lockedQC`, `highQC` and `validBlock` from the consensus-state file. `v.round` is restored from the rows. A leader with a `proposal(H,r)` row re-sends its stored pending proposal. If that file is missing or corrupt, the leader does **not** propose in round r again (a new proposal would equivocate) and waits for r+1. A commit whose rows are durable but whose signature was never sent is harmless: the signature can be recomputed identically. If the QC file is lost but the lock row survives, the validator still enforces its lock and reports only what it can prove (`highQCRound = -1`). Liveness then depends on another lock holder reporting the QC.

---

## 7. Section 5: Safety invariants (proof sketches)

**Fault model.** Signatures are unforgeable. At most f validators are Byzantine. Honest validators follow §3–§6 with durable, fsync-before-sign journals. Network and clocks are arbitrary (asynchronous) for safety. Three facts are used:
- (Q1) Two sets of q validators intersect in ≥ 2q − n validators.
- (Q2) q > 2n/3 and f < n/3 give 2q − n > n/3 > f, so every intersection contains an honest validator.
- (Q3) n − (q − f) < q, which is equivalent to f < 2q − n, i.e. (Q2).

### 7.1 S1: no honest validator signs conflicting votes for the same step
For each (H, r, step), an honest journal holds at most one value (§6.2-1). The row is fsynced before the signature exists (as `reserveChoice:972-991` does today). An ambiguous write fail-stops the journal (`:983-990`), and replay restores every row (`open:812-827`). So across crashes and restarts at most one signed value exists per (H, r, step), and re-signing the same value yields identical bytes. Byzantine validators can equivocate. The proofs below rely only on honest validators.

### 7.2 S2: a lock is released only by valid higher-round evidence
A lock changes only through §4 rule 1 (commit on a QC of a strictly higher round) and never decreases (§6.2-5). An honest validator prepare-votes a value other than its lock only under SAFE-VOTE's third disjunct. That requires a PrepareQC for that value with round > lock round, verified against `validatorsAt(H)` and the `prepare-vote` domain (§4 rule 4). No other input changes this behaviour.

### 7.3 Lemma L1: at most one value has a PrepareQC at (H, r)
Two QCs at (H, r) for B ≠ B' share an honest signer (Q2). That signer would hold two different `prepare(H,r)` values, contradicting S1. ∎

### 7.4 Lemma L2: if B is committed at (H, r), no PrepareQC for B' ≠ B exists at any round r' > r
B committed means q CommitVotes at (H, r), so at least q − f honest validators hold lock (r, B), persisted before signing. Induct on r' > r. Hypothesis: no QC for a value ≠ B exists in rounds (r, r'). Locks move only to QC'd values at higher rounds, so by the hypothesis every honest lock with round ≥ r is on B. A QC for B' at r' needs q prepare votes. A locked honest validator prepare-votes B' only with a justify QC for B' at a round in (lock.round, r') ⊆ (r, r'), and by the hypothesis none exists. So at most n − (q − f) validators can vote for B', and n − (q − f) < q by (Q3). ∎

### 7.5 Theorem S3: no two conflicting blocks finalize at the same height
Suppose B is final at (H, r) and B' ≠ B is final at (H, r'), with r ≤ r'. The finality certificate for B' has q signers, so it contains an honest one (q > f). An honest validator commits only on a valid PrepareQC of that round, so a QC for B' exists at r'. If r' = r this contradicts L1, and if r' > r it contradicts L2. Every full node (`validateFinalizedTransition`) and light client checks the finality certificate: q distinct CommitVotes for `(H, commitRound, hash)` under `validatorsAt(H)`, all from one round. So no honest node accepts a block without one. ∎
**Timing, the TC and the leader rule appear nowhere in this proof.** Safety therefore holds under asynchrony, partitions, clock skew and Byzantine leaders.
**Mutation sensitivity** (test T12): each of the following must make the checker find a counterexample: removing the lock check, allowing a commit without a QC, a non-strict unlock (`justifyRound ≥ lock.round`), two prepare values per round, counting commit votes across rounds, or the one-phase variant of §5.4.

**Phase 0 correction to the mutation list (2026-10-04, executable model).** Two of these claims are not true individually, because the rules defend each other:
- *Non-strict unlock alone* is masked by L1. An unlock with `justifyRound = lock.round` can only target the locked value, since one round has at most one QC.
- *Two prepare values per round alone* is masked by the strict unlock. A second QC at round r cannot unlock a validator locked at r.
- Only the **combination** "non-strict unlock + two prepare values" is unsafe. Random search finds it (for example seed 1893, n = 2, b = 1).
- *Removing the lock check* is masked while validators enforce the leader obligation (§4.6), which is an independent barrier in practice. With the leader check disabled, the mutation is found (seed 57, n = 2, b = 1) while the unmutated protocol stays safe (0 failures in 50 000 schedules). This confirms the §7 claim that safety rests on the lock rules alone.
- *Cross-round commit counting* is shown by a scripted schedule (S3 violation). Random search did not find it in 3 000 seeds.

T12 therefore asserts: commit-without-QC, no-lock-check (with the leader check off), non-strict-unlock + two-prepare-values, cross-round counting (scripted), both §5.4 one-phase variants, and "timeout exclusive with an earlier vote" (a liveness violation) are detected. The two single mutations are asserted to be masked.

### 7.6 Small validator sets (n = 2, n = 3 explicitly)
| n | q | safety holds for up to (2q − n − 1) Byzantine | liveness tolerates (n − q) silent | remark |
|---|---|---|---|---|
| 1 | 1 | 0 | 0 | single operator |
| 2 | 2 | 1 | **0** | either validator offline stops progress. v6 resumes automatically when it returns (today one failed proposer attempt can halt permanently, §14) |
| 3 | 3 | 2 | **0** | `validatorQuorumSize(3) = 3` (asserted in `docs/CONSENSUS_CERTIFICATE_MODEL.md`); one crash stalls until recovery |
| 4 | 3 | 1 | 1 | smallest set with real BFT (f = 1) |
| 7 | 5 | 3 | 2 | f = 2 |
For n = 2 and n = 3, "fault tolerance" means only safety against equivocating minorities (every certificate needs every validator). **No validator may be unavailable.** v6 turns the failure mode from "permanent halt after one bad round" into "pause while a validator is down, automatic resume after". Lowering q to 2 for n = 3 would buy crash tolerance at the price of Byzantine safety (the A+B / B+C counterexample, already detected by `consensus-certificate-model.test.ts:195`), so it must not be done.

---

## 8. Section 6: Liveness conditions

### 8.1 Assumptions
Partial synchrony: after an unknown global stabilisation time **GST**, every message between honest validators arrives within **Δ**, local processing (including fsync and signing) takes ≤ **π**, and honest clocks differ by ≤ **ε**, while the rollback guard (`MAX_VALIDATOR_CLOCK_ROLLBACK_MS` = 1 000, `node-base.ts:65`) stays in force. At least **q honest validators are up and connected** (n − q may be crashed or Byzantine). The pull collection deadline is **C** (suggested 8 000 ms, same as `NATIVE_CONSENSUS_COLLECTION_TIMEOUT_MS`, `p2p-consensus.ts:23`).

### 8.2 The leader learns the highest honest lock
After GST, an honest leader of round r+1 that pulls `timeout(H,r)` from all validators gets a reply from every honest validator within 2Δ + π ≤ C. Each reply carries that validator's highQC, and highQC.round ≥ lock.round always holds, since the QC that caused the lock is stored as highQC. So M.round ≥ every honest lock round, and every honest validator's SAFE-VOTE accepts the proposal. The disjunct is lock.hash == B or justifyRound > lock.round. Equal rounds imply equal values (L1). A Byzantine report of a *higher valid* QC is harmless, because a valid QC unlocks everyone. If the leader does not hold the block for M, it fetches it by hash from any signer of M (≥ q − f ≥ 1 honest signer validated it).

### 8.3 Bounded round changes
Required work in a round with an honest leader:
`T_need = C + 4Δ + 2π + ε + TIMEOUT_GUARD_MS`, covering pull, `prepare` round trip, `commit` round trip, skew and guard.
With C = 8 s, Δ = 1 s, π = 0.5 s, ε = 1 s and guard = 2 s, T_need ≈ 16 s, below ROUND_BASE_MS = 30 s. In round 0 no pull is needed. Let R* be the first round with `roundDuration(R*) ≥ T_need` after GST (R* = 0 with the suggested values). Growth gives a fallback if real Δ is larger. Leaders rotate by `(H − 1 + r) mod n` (`block.ts:expectedValidator:185`), so among any n consecutive rounds at most f leaders are faulty. **After GST and from round R* on, H finalizes within f + 1 rounds.** The first honest leader succeeds by §8.2 and the T_need bound. For n = 4 (f = 1): worst case about 30 s + 35 s, i.e. finality within about 65 s after GST, even with a crashed leader.

### 8.4 Clock skew
- Safety uses no clocks (§7.5).
- Liveness needs ε ≤ `TIMEOUT_GUARD_MS`. A leader whose clock runs ahead by ≤ ε is not refused by peers, and the leader retries refused pulls every ≤ 1 s until its round ends (unlike today, §8.6).
- The existing clock rollback guard and the block timestamp rules (`chain.ts` timestamp checks) stay unchanged. A re-proposed block keeps its **origin** header (timestamp and round), which already passed validation at its origin round. Header validation of a re-proposal checks the origin round's slot (`Block.header.round ≤ r`), not the current round.

### 8.5 Proposer failure
| failure | effect | recovery |
|---|---|---|
| leader crashes before `prepare` | no votes | timeouts at round end; next leader (fresh block or M) |
| crash after partial `prepare` | some prepare votes, no QC | prepare votes do not lock; timeouts are legal (§6.3); next leader proposes freely or re-proposes M |
| crash after partial `commit` | some honest validators locked on B (QC exists) | their timeouts report QC(r,B); next leader re-proposes B (§8.2); test T2b |
| crash after finality but before broadcast | B is final but unknown to the others | the others lock or QC B; any later round re-proposes B, producing a second certificate for the **same** B (allowed, S3) |
| equivocating leader | at most one value gets a QC (L1) | timeout; next leader |

### 8.6 Interaction with the fixed 30 s tick (root cause of the devnet split)
Today `cli.ts:500-506` drives `produceFinalizedBlock` with `setInterval(…, BLOCK_INTERVAL_MS)`, and the tick period equals the round window (`node-base.ts:63-64`). Each node therefore polls at a **fixed phase** relative to the round grid, set at process start. Three failure paths follow:
1. **Late-phase leader collides with the next round.** A round-r proposer at offset d after `roundStart(H,r)` sends `attest` at time t. A peer whose tick for round r+1 fires at t + g, with g < L (attest delivery), executes `skip(H,r)` first and refuses the attest. The proposer has already reserved its own attest, which gives the permanent split of §14.
2. **Early-phase leader is refused.** A leader whose tick falls before a lagging peer's deadline gets "Round skip deadline has not elapsed" (`node-base.ts:421-422`). It does not retry until its next tick, 30 s later, which is already the next round.
3. **No retry inside a round.** Any transient failure costs the whole round.
v6 removes the hazard structurally: timeouts are always legal after votes (§6.3), so path 1 cannot cause a split. The event-driven pacemaker (§3.3, polls ≤ `ROUND_BASE_MS/10`) removes paths 2 and 3. An interim change to the v5 binary's timing **mitigates path 1 only**. Path 2 (peer offline when round 0 is attempted, §14.3) remains possible under v5, because it needs no message race at all.

---

## 9. Section 7: Persistence requirements

### 9.1 What must be durable before each signature
| artefact | location | write discipline |
|---|---|---|
| journal rows (§6.1) | existing `signing-journal.ndjson` | append + fsync before signing (as `storage.ts:reserveChoice:953-992`) |
| lock + commit rows | same file, **one** append with both lines | single `write` + fsync. Replay accepts the pair only if both lines parse, otherwise fail-stop (ambiguous) |
| lockedQC, highQC, validBlock | `consensus-state/H-<h>.json` | write tmp → fsync → rename → fsync dir. Written **before** the lock row |
| pending proposal | `consensus-state/H-<h>-r-<r>.proposal.json` | same discipline, before the Proposal signature |
Ordering for COMMIT: QC file → lock+commit append + fsync → sign. A crash anywhere in this sequence leaves either no lock (never signed, safe) or a lock with its QC (complete).

### 9.2 Journal row format v2
- Legacy rows stay valid: `{"height","round","kind":"attest"|"skip","value"}` (parsed by `SigningJournal.open`, `storage.ts:812-826`).
- New rows: `{"v":2,"height":int,"round":int,"step":"block-proposal"|"proposal"|"prepare"|"lock"|"commit"|"timeout","value":hex64[,"lockRound":int]}`.
- Each line ≤ 1 024 bytes and ≤ 128 JSON tokens, keeping today's parser bounds.
- The v6 binary reads both formats. Old binaries accept extra keys but require `kind ∈ {attest, skip}` (`storage.ts:817-820`). v2 rows deliberately carry **no** `kind` key, so an old binary throws `Corrupt signing journal entry` on them, and a **downgrade fails closed** instead of silently forgetting locks. This must be pinned by a test (T10), because adding a `kind` field to v2 rows would silently break the guard.

### 9.3 Compaction and integrity
`compactThrough(H)` (`storage.ts:888`) also deletes `consensus-state/H-≤H*` after finality. Lock rows are needed only until their height finalizes. A per-line checksum (finding F-10) is recommended for the v2 format but is not designed here.

---

## 10. Section 8: Compatibility with protocol versions 1/2/3/5

| version | state model | consensus under this design |
|---|---|---|
| 1, 2, 3, 5 | unchanged | unchanged legacy single-phase protocol (attest + skip chain). Validation of historical blocks is byte-for-byte unchanged |
| 4 | — | remains unsupported |
| **6** (new) | v5 state model | v6 consensus of §3–§9 |
- **A new version number is required.** The block certificate format changes (CommitVotes with `commitRound`, no skip chain), as do the signature domains and the journal. Mixing would break historical validation.
- **Activation** uses the existing governance path: a `protocol_upgrade` with q approvals and an activation height ≥ current + `MIN_PROTOCOL_UPDATE_DELAY` (100, `chain.ts:63`). Binaries without v6 support fail-stop at the activation height instead of forking: they reject unknown protocol versions at `chain.ts:368`, `:434` and `:445`, behaviour covered by `l1.test.ts:2989`.
- **Light clients** (`l1/src/light-client.ts:8,42,82,121-122`) and the independent Python verifier (`l1/independent-light-client/verify_vector.py`: `SUPPORTED_PROTOCOL_VERSIONS` at line 34, signature domains at lines 31-33) must learn v6 certificates **before** activation.
- **Remote signer** (`l1/src/validator-signer.ts`: intent type at line 13, `RemoteValidatorSigner` at line 40, `validatorSigningDomain` at line 120) needs new intents `consensus-proposal`, `prepare-vote`, `commit-vote` and `round-timeout`, with the same slashing-protection rules as §6 enforced signer-side.

---

## 11. Section 9: Test plan

**Harness:**
- Reuse the F-03 test harness: `openValidator` (`l1/test/f03-missed-proposer-protocol-versions.test.ts:126`), `httpTransport` (`:140`) and `nativeTransport` (`:167`), which run real `NodeService` instances, real journals and a controllable clock.
- Tests marked **[H+N]** run over both HTTP and native libp2p transports.
- Every test asserts **no conflicting finality**: all nodes' finalized hashes at each height are equal, and no two valid certificates for different hashes exist.
- "Current code" is the result on the F-03 head (`8a07c0c`). Rows marked "reproduced" were run as scratch proof-of-concept programs (not committed).

| id | name | setup | fault injected | steps | assertions (v6) | current code |
|---|---|---|---|---|---|---|
| T1 | `devnet-2v-tick-phase-split-recovers` [H+N] | n=2, height 1 final, v1 schedule | round-0 proposer's attest reaches the peer g < L ms after the peer's round-1 timeout tick | run rounds 0-9 with full connectivity after round 1 | H=2 finalizes by round 2. Journals legal. No conflicting finality | **fails, reproduced** (scratch PoC: g = 2/5/10 ms gives `2:0=attest`/`2:0=skip`, never finalizes in rounds 2-9) |
| T1b | `peer-offline-round0` [H+N] | n=2 | peer down for the whole round-0 attempt, back for round 1 | as T1 | finalizes after the peer returns | **fails, reproduced** (path 2: permanent halt, "Conflicting validator action prevented") |
| T2 | `4v-split-2prepare-2timeout` [H+N] | n=4, q=3 | round-0 `prepare` reaches 2 validators only | rounds 0-3 | no QC at round 0. Round 1 finalizes (fresh block or same). Prepare votes do not block timeouts | **fails, reproduced** (scratch PoC, n=4 over HTTP: heights stay 0 for about 5 rounds, "Conflicting validator action prevented") |
| T2b | `partial-commit-lock-carried-forward` | n=4 | QC(0,B) formed, `commit` delivered to 1 validator, leader crashes | rounds 1-2 | round-1 leader re-proposes B with justify QC(0,B). Final block = B | not applicable (no lock concept) |
| T3 | `asymmetric-partition-heal` [H+N] | n=4 | {v1,v2} vs {v3,v4} for k rounds, plus one-way loss to the leader | heal and run | no finality during the partition. Finalizes within f+1 rounds of heal. Locks honoured | halts permanently once any split round occurs |
| T4 | `proposer-crash-after-partial-broadcast` | n=4 and n=7 | crash after `prepare` to s recipients, for every s | restart and run | finalizes. Restarted leader re-sends its stored proposal, never a new one | halts for n−q < s < q |
| T5 | `restart-while-locked` | n=4 | crash the locked validator between QC file, lock row and signature (fault points at each fsync) | restart | lock and QC restored, or no lock and no signature. No conflicting vote after restart | partially covered by a scratch journal-crash PoC (no acknowledged reservation lost across SIGKILL; a torn tail fail-stops reopen) |
| T6 | `repeated-round-changes-bounded` | n=4 | crashed leader plus random drops before simulated GST | run 50 rounds | after GST, finality within f+1 rounds of R* | stuck after the first split |
| T7 | `byzantine-equivocating-proposer` | n=4, v4 Byzantine | v4 sends B and B' (the §5.4 schedule), withholds certificates, reports stale and forged highQCs | run | at most one QC per round. No conflicting finality. Liveness after an honest leader | safe today, but can halt |
| T8 | `clock-skew` | n=4 | clocks offset by ±ε and ±(ε + 1 s) | run | finalizes with ±ε. Safety under any skew. Rollback guard trips on rollback > 1 s | early-phase leader refused (`node-base.ts:421-422`) |
| T9 | `randomized-schedule-no-conflicting-finality` | pure state-machine model plus journal model, n ∈ {1,2,3,4,7}, Byzantine up to 2q−n−1 | ≥ 10 000 seeded schedules (drops, reorders, crashes, restarts, equivocation) | random | S1-S3 hold. Liveness after injected GST | model exists for certificates only (`consensus-certificate-model.test.ts`) |
| T10 | `journal-v2-migration-and-downgrade` | legacy journal plus v2 rows | open with v6 and with the current binary; torn lock+commit pair | replay | v6 reads both. The current binary refuses v2 rows. A torn pair fails stop | not applicable |
| T11 | `activation-boundary-v5-to-v6` | v5 chain, upgrade at A | old binary at A; in-flight round at A−1 | run across A | A−1 uses the legacy rules, A uses v6. Old binary fail-stops at A | upgrade fail-stop exists (`l1.test.ts:2989`) |
| T12 | `model-mutations-detected` | T9 model | mutations of §7.5 | run the checker | each mutation finds a counterexample (see the Phase 0 correction in §7.5: the two single mutations are masked, their combination is detected) | non-strict quorum mutation already detected (`consensus-certificate-model.test.ts:195`) |
| T13 | `event-driven-scheduler` | n=2 and n=4 | start-time offsets across the whole window | run 20 heights | no round lost to tick phase. Leader retries ≤ 1 s | 30 s tick phase-locked (§8.6) |

**CI gates:**
- T1-T8, T10, T11 and T13 run in the main L1 suite.
- T9 runs a 2 000-schedule smoke test per PR and the full ≥ 10 000 nightly.
- T12 runs per PR.
- `devnet:check` must pass **20 consecutive runs** (it is flaky today, §15-3).

---

## 12. Section 10: Migration plan

1. **Ship first, activate later.** Release a binary that supports v6 but keeps running v1/2/3/5 under the legacy rules. It includes the event-driven pacemaker for the legacy path (an interim mitigation of §8.6 path 1 only) and the v2 journal reader. Light clients, the Python verifier and the remote signer are updated in the same release.
2. **Upgrade the validators**, then confirm through `/status` and the metrics that every validator reports v6 support. A governance `protocol_upgrade` to 6 needs q approvals and an activation height A ≥ current + 100 (`chain.ts:63`). This design recommends a margin of **≥ 2 000 blocks** (about 17 h at 30 s), so that lagging operators can upgrade.
3. **At the boundary**, heights < A use legacy rows and legacy certificates, and heights ≥ A use v2 rows and v6 certificates. Each height runs entirely under one protocol, decided by `protocolVersionAt(H)`, so **no in-flight round crosses A**. Rule §6.2-7 rejects mixed rows at one height. Caveat: a legacy F-01 split at a height < A halts the chain before A, so the activation cannot rescue it. Recovering a chain that is already halted needs a separately designed, signed operator procedure (§16.9).
4. **Rollback** is only possible **before A**: cancel or replace the upgrade through governance. After A, old binaries fail-stop by design.
5. **Never hand-edit journals.** Compaction after finality removes the v2 rows and consensus-state files.
6. Keep the n = 2 devnet as a test target, but **require n ≥ 4 for any network that claims crash tolerance** (§7.6).

---

## 13. Mapping to existing code (reuse / change / new)

| existing location | role today | v6 action |
|---|---|---|
| — | — | **new** `l1/src/consensus-v6.ts`: pure state machine (§3), SAFE-VOTE, QC/TC types and validation, pacemaker math |
| `node.ts:produceFinalizedBlock:306` | proposer loop (skip chain, then attest, then finalize) | **change**: dispatch on `protocolVersionAt(H)`. The v6 leader path does pull, then prepare, then commit, then finalize. The legacy path stays as it is |
| `node-base.ts:attestProposal:370` | peer attest handler | keep for legacy. **New** `prepareVote`/`commitVote` handlers |
| `node-base.ts:signPreparedProposal:394` | proposer self-sign | keep for legacy. **New** proposal signer with a `proposal` row |
| `node-base.ts:requestSkipVote:408` | skip handler (deadline at :421-422) | keep for legacy. **New** `timeoutVote` handler (§3.4 TIMEOUT) |
| `node-base.ts:acceptFinalizedBlock:463` | finalized-block intake | **change**: v6 certificate validation |
| `node-base.ts:ConsensusPeerClient:135` | transport interface | **extend** with `requestPrepare`, `requestCommit`, `requestTimeouts` |
| `node-base.ts:702-745` | HTTP `/proposal/attest`, `/round/skip`, `/block` | **new** routes `/v6/prepare`, `/v6/commit`, `/v6/timeout` with their own byte limits |
| `p2p-consensus.ts:14`, `:174` | native protocol 1.0.0 and client | **new** protocol `/zyronchain/consensus/2.0.0`; 1.0.0 is kept for legacy heights |
| `storage.ts:SigningJournal:794`, `open:803-854`, `reserveChoice:953` | journal | **change**: v2 rows, step dimension, rules §6.2, atomic pair append, consensus-state files |
| `storage.ts:compactThrough:888` | compaction | **change**: also delete consensus-state files |
| `block.ts:validateRoundCertificate:252`, `validateRoundSkipQuorum:268` | skip chain checks | legacy only. **New** QC/TC validators reuse their membership and duplicate logic |
| `block.ts:validateAttestationQuorum:385`, `validateBlockAttestation:400` | finality checks | **change**: v6 checks q CommitVotes from one round |
| `block.ts:validateBlockShape:328`, `validateBlockEnvelope:200` | shape and envelope | **change**: v6 fields (`commitRound`, empty `roundCertificate`) |
| `block.ts:attestationPayload:177`, `signForProtocol:435`, `verifyForProtocol:446` | domains | **extend** with v6 domains: `consensus-proposal`, `prepare-vote`, `commit-vote`, `round-timeout` |
| `block.ts:createRoundSkipVote:130` | skip vote | legacy only. Remove the `?? 1` default at :150 (§15-6) |
| `block.ts:expectedValidator:185`, `validatorQuorumSize:195` | leader, q | **reuse unchanged** |
| `chain.ts:SUPPORTED_PROTOCOL_VERSIONS:64`, `protocolUsesStateV2:66` | versions | **change**: add 6 (v5 state model) |
| `validator-signer.ts` | intents | **extend** (§10) |
| `light-client.ts`, `independent-light-client/verify_vector.py` | header verification | **extend** (§10) |
| `cli.ts:500-506` | 30 s `setInterval` tick | **replace** with the event-driven pacemaker (§3.3) |
| `consensus-diagnostics.ts` | `roundSkipVotes` metric (F-03) | **extend** with `round`, `lockRound`, `highQCRound`, timeouts and pull failures |

---

## 14. Devnet natural split: mechanism and exact configuration

**Configuration:**
- `BLOCK_INTERVAL_MS = 30_000` (`l1/src/node-base.ts:63`) and `ROUND_WINDOW_MS = 30_000` (`:64`).
- The validator tick is `setInterval(produceFinalizedBlock, BLOCK_INTERVAL_MS)` (`l1/src/cli.ts:461` schedule helper, `:500-506` registration).
- The devnet (`l1/scripts/local-devnet.mjs`, `npm run devnet:check`, `l1/package.json:21`) runs n = 2 (q = 2) on loopback. `start()` is at `:67-82`, and the nodes start back to back at `:147-148`. The restart stage stops B at `:251`, lets A run alone for 35 s (`:254`) and restarts B at `:259`, followed by "finality resumes after validator restart" at `:260`.
- Leader rule `index = (H − 1 + r) mod n` (`block.ts:185-193`), with A = `validators[0]`: **A leads odd heights at round 0 and even heights at round 1, B the opposite.**
- The round grid of height H is anchored at the tip timestamp (`node.ts:316-318`), which is the previous proposer's tick time. So every node polls at a **fixed phase** relative to the grid (§8.6).

### 14.1 Path 1: message race at a round boundary (all nodes up)
For an even H, B proposes at round 0 at its tick, which is d after A's tick (the grid is anchored on A's previous block). A's next tick, 30 s − d later, falls in round 1. A is the round-1 leader, so it first signs `skip(H,0)` itself and requests B's skip. If B's `attest` request for round 0 has not yet been processed by A, that is, **30 s − d < L** (attest delivery and processing, about 11-20 ms on loopback), then A's journal holds `H:0 = skip` and B's holds `H:0 = attest`. The result is a permanent halt (§1, F-01). A scratch PoC against the production `dist`: g = 2/5/10 ms gives a split, and rounds 2-9 never finalize. g ≥ 20 ms finalizes at round 0. g = 0 makes B compute round 1, and A finalizes round 1.

### 14.2 Path 2: proposer acts while the peer is offline (restart stage)
For n = 2, `n − q = 0`: the proposer's own reservation alone puts it into the "split" interval. **No message needs to be delivered at all.** If A's round-0 tick for an odd H falls while B is stopped (between `:251` and B's startup after `:259`), A reserves `H:0 = attest`, cannot reach B, and fails. When B returns, it signs `skip(H,0)` at its round-1 tick, and A refuses: "Conflicting validator action prevented for consensus round". The halt is permanent. The PoC reproduces this. It happens when A's tick phase falls about 6-9 s after B's, so A's round-0 tick lands inside B's downtime.

### 14.3 Evidence from `devnet:check` on the F-03 head
- **Earlier runs:**
  - In place in the working checkout: 0/4 pass on the pre-rebase F-03 head, and 0/1 on the audited `bdc1e9e`.
  - The failures hit the transfer stage (height 2, round 0, B attested, A skipped: path 1) and the restart stage (height 3, round 0, A attested alone, B skipped: path 2).
  - Fresh `git archive` copies passed 5/5 (3 audited, 2 fixed).
- **On the rebased branch:** run 1 on `0788686` passed, and run 2 on `8a07c0c` failed at "finality resumes after validator restart".
- Saved journals: A `{"height":3,"round":0,"kind":"attest"}` and B `{"height":3,"round":0,"kind":"skip",...}`, with logs showing "Round skip quorum not reached: 1/2" at protocolVersion = 1. H = 3 is odd, A is the round-0 leader, and the failure is in the restart stage, which is path 2.
- The protocol is **v1**, so the F-03 change (v3+ skip domain and protocol version handling) is not involved.
- Both paths need A's tick shortly after B's tick (cyclically). The process start order (`:147-148`) and the restart (`:259`) set those phases. **Why one checkout location produces the unfavourable start-up skew more often than another is not established**, because the node logs carry no timestamps. The stable conclusions are that `devnet:check` is phase-dependent, not deterministic, and that a PASS is not a baseline.

---

## 15. Contradictions with earlier conclusions (to be corrected)

1. **"With n=2 or n=3, any partial delivery is enough"** (internal audit F-01 item 5 and its deep dive) understates the problem. For n ≤ 3, `n − q = 0`, so even **zero** delivery splits a round: the proposer's own self-reservation (`node.ts:403-407`) followed by any peer's skip is enough. One unreachable peer during the proposer's tick halts an n = 2/3 chain permanently (§14.2, reproduced).
2. **The audit's alternative fix** (item 8: "let round-r+1 timeouts carry the highest attested proposal forward"; also "a per-height lock on the highest value a validator has attested", Proposed changes section) is a **one-phase** design. §5.4 shows that with one Byzantine validator it either halts or violates safety. A second voting phase with a QC-backed lock is required.
3. **"`devnet:check` PASS"** (internal audit baseline) is not a stable baseline. The check depends on tick phase and fails naturally through F-01 (§14.3: PASS on `0788686`, FAIL on `8a07c0c` with legacy v1 journals showing an attest/skip split).
4. **`roundCertificate` is not covered by the block hash or the proposer signature.** It lives on `Block` (`types.ts:144`), not in `BlockHeader`, and `blockHash` (`block.ts:25`) hashes only the header. Only the round r−1 skip certificate is embedded, and the chain back to round 0 is enforced only when a validator signs a skip (`node-base.ts:426-437`). So the certificate is malleable by relayers: any valid quorum can be substituted. Finality is unaffected because the attestations bind the header, but v6 must bind all consensus evidence into signed payloads (§5.1) or treat it as unsigned hints.
5. **`attestProposal` enforces no round deadline.** `chain.validateProposal` (`chain.ts:443-450`) and `validateBlockEnvelope` check only increasing time and at most 120 s in the future (`block.ts:224-225`). A late round-r proposal is attested whenever the validator has not skipped r. This is part of the path 1 race and is acceptable only under v6 rules (a prepare vote does not lock).
6. **`createRoundSkipVote` still defaults `protocolVersion ?? 1`** (`block.ts:150`). The F-03 change made verification require an explicit version, but vote creation keeps the legacy default. No current caller omits it, yet the audit's "no v1 default" recommendation is only half implemented. This should be removed in the v6 work (§13).
7. **Audit line references are shifted at the F-03 head:**
   - `attestProposal` 369-391 → 370-392.
   - `signPreparedProposal` 393-405 → 394-406.
   - `requestSkipVote` 407-460 → 408-461, with its certificate check 425-436 → 426-437.
   - `validateRoundCertificate` `block.ts:245-259` → 252-266.
   This document uses the F-03 head.

---

## 16. Required end sections

### 16.1 Normative protocol rules (v6)
- **R1. Single value per step.** An honest validator signs at most one value per (H, r, step) for step ∈ {block-proposal, proposal, prepare, commit, timeout}. The journal row is fsynced before signing.
- **R2. Prepare (SAFE-VOTE).** Prepare-vote B at (H, r) only if `r ≥ v.round`, the proposal comes from `L(H,r)` with a valid TC(H, r−1) for r > 0, B is a valid block for H, and `lock = ⊥ ∨ lock.hash = B ∨ justifyRound > lock.round` with a valid PrepareQC(justifyRound, B).
- **R3. Commit and lock.** Commit-vote B at (H, r) only on a valid PrepareQC(H, r, B), after durably persisting the QC and `lock := (r, B)`.
- **R4. Unlock.** The lock changes only through R3 at a strictly higher round. There is no other release.
- **R5. Timeout.** Once `now ≥ roundEnd(H,r) − TIMEOUT_GUARD_MS`, a timeout(H, r) is always permitted, once, whatever was signed earlier in round r. It carries the signer's highQC. After it, nothing is signed for rounds ≤ r.
- **R6. Leader.** `L(H,r) = expectedValidator(validatorsAt(H), H, r)`. For r > 0 it pulls timeouts from all validators, builds TC(H, r−1), and re-proposes the block of the maximum verified highQC, or any valid block if none exists. A same-round retry re-sends the stored proposal.
- **R7. Finality.** Block B is final at H iff there are q CommitVotes for (H, r, B) from distinct members of `validatorsAt(H)`, all with the same r.
- **R8. Quorum.** `q = floor(2n/3) + 1`, unchanged. It is never lowered for small n.
- **R9. Scheduling.** Consensus actions are event-driven. No fixed-period tick may determine round participation. Polls are ≤ ROUND_BASE_MS/10, and the leader retries within its round.

### 16.2 Safety argument (summary of §7)
- R1 gives S1: one honest value per step.
- Quorum intersection with q > 2n/3 and f < n/3 yields an honest common signer, so at most one QC per round (L1).
- Once B is committed at r, at least q − f honest validators are locked on B, and by R2/R4 they vote for another value only with a higher QC for it. Since n − (q − f) < q, no such QC can form, by induction on rounds (L2).
- Finality requires a QC (R3, R7), so two conflicting final blocks would contradict L1 or L2 (S3).
- No step uses clocks, the TC, or leader honesty.

### 16.3 Liveness argument (summary of §8)
- After GST, with ≥ q honest validators up, an honest leader's all-validator pull sees every honest highQC (≥ every honest lock), so all honest validators accept its proposal (SAFE-VOTE).
- Timeouts never conflict with earlier votes (R5), so no honest state blocks progress.
- With `roundDuration ≥ T_need` (≈ 16 s with the suggested values, R* = 0), the first honest leader finalizes.
- Rotation gives an honest leader within f + 1 rounds.
- The event-driven scheduling (R9) removes the tick-phase failures of §8.6.

### 16.4 Code changes required (by file)
- `l1/src/consensus-v6.ts` (new): types (Proposal, PrepareVote, CommitVote, TimeoutVote, PrepareQC, TC), validation, the SAFE-VOTE predicate, pacemaker math, and the pure transition functions used by both production and the model checker (T9).
- `l1/src/node.ts`: version dispatch in `produceFinalizedBlock`, the v6 leader path, HTTP client methods, and per-kind response limits (about 64 kB for timeout responses that carry QCs).
- `l1/src/node-base.ts`: `prepareVote`, `commitVote` and `timeoutVote` handlers under `exclusive`, new HTTP routes, and the `ConsensusPeerClient` extension. Legacy handlers stay unchanged.
- `l1/src/p2p-consensus.ts`: protocol `/zyronchain/consensus/2.0.0` with kinds `prepare`, `commit`, `timeout` and `block`, plus request and response limits.
- `l1/src/storage.ts`: v2 journal rows, step-aware reservations, rules §6.2, atomic pair append, consensus-state files, and compaction.
- `l1/src/block.ts`: v6 domains and payloads, finality validation for v6, the envelope for `commitRound`, and removal of the `?? 1` default.
- `l1/src/chain.ts`: protocol version 6 support (v5 state model), certificate validation dispatch, and re-proposal header checks (origin slot).
- `l1/src/validator-signer.ts`: new intents and signer-side slashing protection.
- `l1/src/light-client.ts` and `l1/independent-light-client/verify_vector.py`: v6 certificate verification and test vectors.
- `l1/src/cli.ts`: event-driven pacemaker in place of the 30 s `setInterval`.
- `l1/src/consensus-diagnostics.ts`: v6 metrics.
- Docs: `docs/L1_OPERATIONS_RUNBOOK.md` and `docs/CONSENSUS_CERTIFICATE_MODEL.md`.

### 16.5 Storage / schema changes
- **Journal v2 rows** (§9.2): `{"v":2,height,round,step,value[,lockRound]}`, with no `kind` key so old binaries fail closed.
- **`consensus-state/H-<h>.json`** holds `lockedQC`, `highQC` and `validBlock`. **`consensus-state/H-<h>-r-<r>.proposal.json`** holds the pending proposal. Both are atomic (tmp + fsync + rename + dir fsync).
- **Block format for v6:** `attestations` become CommitVotes, a new `commitRound` field is added, and `roundCertificate` must be empty. The block log stores blocks as today.
- No change to the state model (v5 state-v2), token supply or allocations.

### 16.6 Tests and CI gates
- §11 tests T1-T13. T1, T1b and T2 must fail on the current code (characterization first) and pass on v6.
- **Per PR:** full L1 suite, T9 smoke run (2 000 schedules), T12 mutation run, typecheck and build, and the light-client vectors (TS and Python).
- **Nightly:** T9 with ≥ 10 000 schedules, plus 20 consecutive `devnet:check` runs. An n = 4 devnet variant is recommended.
- The existing F-03 tests and the certificate model tests must stay green.

### 16.7 Migration plan
- See §12: ship a v6-capable binary (with the legacy timing mitigation), upgrade the validators and light clients, propose a governance upgrade with a margin of ≥ 2 000 blocks, and switch per height at A.
- Rollback is possible only before A. Never edit journals.
- A legacy split before A needs a separately designed recovery procedure.

### 16.8 Implementation phases
- **Phase 0, characterization and timing:**
  - Land T1, T1b and T2 as expected-failing tests.
  - Add timestamps to the devnet logs.
  - Optional interim legacy mitigation: event-driven tick, with no consensus rule change.
- **Phase 1, pure types:** `consensus-v6.ts` types, validation, SAFE-VOTE and the pure transition functions, plus the model checker (T9, T12).
- **Phase 2, journal v2:** storage rows, rules, consensus-state files and the downgrade guard (T5, T10).
- **Phase 3, handlers and transports:** HTTP and native 2.0.0 handlers and clients with limits, run in [H+N] harness tests.
- **Phase 4, leader, finality and clients:** the leader path, finality validation, light clients, the Python verifier and the remote signer (T2b, T3, T4, T7, T8, T11).
- **Phase 5, chaos and properties:** asymmetric partitions, restarts, clock skew and the long randomized runs (T6, T9 nightly, T13), plus an n = 4 devnet.
- **Phase 6, review and rehearsal:**
  - External consensus review of this specification and the code.
  - An activation rehearsal on a private test network.
  - Only then a governance proposal on any public network, which is an owner decision.

### 16.9 Open questions (owner decisions)
1. **Timing values:** `ROUND_BASE_MS`, `ROUND_STEP_MS`, `ROUND_MAX_MS`, `TIMEOUT_GUARD_MS`, C, and whether growth is linear (suggested) or exponential.
   - **Decided (default), 2026-10-04:** `ROUND_BASE_MS` = 30 000, `ROUND_STEP_MS` = 5 000, `ROUND_MAX_MS` = 120 000 (linear growth), `TIMEOUT_GUARD_MS` = 2 000, leader jitter 0–250 ms, fallback poll ≤ `ROUND_BASE_MS`/10 (3 s).
2. **F-02 coupling:** v6 derives rounds from TCs and own rows, not raw wall-clock catch-up. Should the `MAX_CONSENSUS_ROUND_CATCHUP` ceiling (`node.ts:36`) be removed together with v6, or handled separately?
   - **Decided (default):** F-02 is not part of this change. The v6 pacemaker stays compatible with a later certified resume-round. The `MAX_CONSENSUS_ROUND_CATCHUP` semantics for v1–v5 are unchanged.
3. **Policy for n ≥ 4:** should networks with n < 4 be labelled as having no crash tolerance, or be refused for public use?
   - **Decided (default):** n < 4 is allowed. Startup and genesis tooling print a clear warning that n = 2/3 have no crash tolerance. Quorum is never lowered.
4. **Interim v5 mitigation:** ship the event-driven tick before v6? It reduces path 1 but not path 2.
   - **Decided (default):** only the devnet/CLI tick change, and only if it is behaviour-neutral for the consensus rules (a poll well below the round window with no overlapping ticks). Otherwise skip it and document why.
5. **Recovery of a pre-activation legacy split:** is a signed, quorum-approved operator procedure acceptable, and how should it be designed without weakening the double-sign protection?
   - **Decided (default):** documented only (operator runbook). No special code.
6. **Light-client certificate format** for v6 (full CommitVote list versus an aggregated encoding later).
   - **Decided (default):** the node implements what correctness requires (full CommitVote list in the block). The TS light client verifies v6 commit certificates. Any verifier without v6 support (the Python verifier, the remote signer by default) fails closed on v6 structures. Aggregated encodings are a follow-up.
7. **Remote signer:** should the signer enforce full §6 rules itself (recommended), or only per-step uniqueness?
   - **Decided (default):** minimum for this change. The remote signer refuses v6 intents unless explicitly enabled, so it cannot sign v6 messages without journal enforcement. Full §6 enforcement inside the signer is a follow-up.
8. **`roundCertificate` malleability** (§15-4): bind it to signed data in legacy versions, or document it as unsigned evidence?
   - **Decided (default):** v6 binds all consensus evidence to signed data. v6 blocks carry an empty `roundCertificate`, finality is the commit certificate over `{chainId, height, commitRound, blockHash}`, and TCs and QCs are verified, never trusted, hints. v1–v5 hashing is **not** changed (consensus-breaking). The legacy malleability is logged as an F-13 candidate.
9. **Activation margin:** confirm ≥ 2 000 blocks or choose another value.
   - **Decided (default):** ≥ 2 000 blocks between the governance approval height and v6 activation. It is enforced as admission/governance policy for upgrades targeting v6 only, with no effect on v1–v5 behaviour.
