# Consensus safety and liveness review

Status: implementation review for the prepare/commit round-change. This is not an activation approval. Quorum remains `floor(2N/3)+1`. Activation flags stay false. Mining economics stay 50_000_000 / 6.25 / 4_000_000 / 20-bit / 1 claim per block.

## Problem

A round finalized only by attestations. Completion returned null when two hashes could both still reach quorum, which is the safe choice, and then no later round opened. For N=4 that is a 2+2 observation (`Q=3`, `f=1`). For N=7 it is 3+3+1 (`Q=5`, `f=2`). N=3 cannot show both hashes reachable under `f=0`. The journal already rejected a second signature from the same validator.

## Design

Prepare (`zyronchain/round-prepare/v1`) is not final. Commit remains `zyronchain/finality-attestation/v1` and still requires `Q` signatures. A view-change (`zyronchain/round-view-change/v1`) never finalizes. It carries nil, or the highest commit whose prepare quorum is on disk or supplied again. A new-round block may embed that certificate only when the highest lock is nil. A verified lock is finished by committing the original block. Two locks at the same round for different hashes reject the certificate.

Timeouts do not finalize. Unseen validators are not assigned. Missing votes are not treated as no. The reveal threshold and the old unique-hash completion path stay. Skip quorum stays for a round nobody prepared.

Lock rule: a later commit of a different hash is allowed only when its prepare quorum round is strictly higher than every conflicting commit. Honest committers of the earlier quorum do not prepare the new hash, and `N - Q + f < Q`, so that quorum cannot be assembled while faults stay within `f`.

Liveness bound, nil-lock case only: after an ambiguous round with no commit quorum, round-robin `validators[((height - 1) + round) mod N]` meets at most `f` Byzantine proposers before an honest one. `X = f + 1` (`roundChangeLivenessBound`). N=4 gives `X=2`. N=7 gives `X=3`. The bound assumes eventual synchrony, faults at most `f`, and honest validators answering in that round. It does not claim every schedule or clock fault. A height that already has a commit quorum finishes that hash.

## Safety invariants

S1–S10 are the constants in `l1/src/round-view-change.ts` and are asserted by `l1/test/consensus-safety-invariants.test.ts`.

| Id | Statement |
|---|---|
| S1 | Quorum is `floor(2N/3)+1` and is never lowered |
| S2 | A hash finalizes only with a commit quorum of finality attestations |
| S3 | An honest validator commits at most one hash in a round |
| S4 | A fresh commit follows a prepare quorum, or the unique-hash completion path |
| S5 | A conflicting later commit requires a prepare quorum from a strictly higher round |
| S6 | Two commit quorums on different hashes require an honest double-sign when faults are at most `f` |
| S7 | Every view-change quorum intersects the honest committers of a commit quorum (`2Q-N-f >= 1`) |
| S8 | A new-round proposal is accepted only for a nil-lock view-change certificate |
| S9 | Timeout and view-change votes do not finalize a hash |
| S10 | Journal and lock-certificate bytes are durable before the signature is returned |

The bounded search `exploreBoundedConsensus` covers prepare assignments for N=3, 4, and 7, partitions N=4 `{2+2, 3+1}` and N=7 `{4+3, 5+2}`, and counts double finalization, conflicting certificates, permanent deadlock after recovery, invalid unlock, and journal loss. It is a quorum-intersection model, not an enumeration of every message schedule. A safety counterexample in that model or in the state-machine tests is a stop-ship.

## Faults, proposer, DoS, persistence

- `f = floor((N-1)/3)`. Honest intersection of two quorums is at least 1 for every accepted set size, including after subtracting `f`.
- Proposer selection is unchanged: `validators[((height-1)+round) mod N]`.
- View-change votes carry a prepare certificate only for a lock. Nil votes are small. Certificate checks reject duplicates, unknown keys, and over-long prepare lists (cap 100, the validator-set cap).
- Journal kinds `prepare` and `view` use distinct slots (`height:round#prepare`, `height:round#view`). A prepare conflicts with a skip or a different commit in that round. The lock file is `lock-certificates/<height>-<round>.json`, fsynced before the commit signature. Losing the file while keeping the commit refuses a nil view-change until the same quorum is supplied and rewritten. An orphan certificate without a journal commit is not a lock.
- Persistence version of the block log is unchanged. The journal line format grew two kinds. Old journals that contain only `attest` and `skip` still open.

## Mixed-version

**NOT SUPPORTED.** Native consensus protocol id is `/zyronchain/consensus/1.1.0`. A 1.0.0 peer fails the handshake. Block header `protocolVersion` stays the chain's current version (initial public-testnet version 1). There is no activation height for this rule change. Homogeneous upgrade is required before a network produces height 1. A mixed set can split: old nodes treat a prepare as if it were absent and can still try to finalize from attestations, while new nodes wait for a prepare quorum. That is not a supported operating mode.

## Tests

- `l1/test/round-double-hash-liveness-regression.test.ts` drives the real `NodeService` for N=4 and N=7, partition heal, crash/restart lock files, and four OS processes with separate directories, keys, and ports.
- `l1/test/split-vote-liveness.test.ts` keeps unique 2-prepare/2-skip and N=7 unique completion on the original hash, and the N=7 ambiguous case now finalizes one later hash.
- `l1/test/consensus-safety-invariants.test.ts` binds S1–S10 and the bounded search.
- `l1/test/consensus-1-1-qualification.test.ts` proves S9 against `validateAttestationQuorum`, protocol-v5 prepare domain separation, malformed `/round/view` HTTP, operational rejection of `/zyronchain/consensus/1.0.0`, and an N=7 OS-process 3+3+1 run. In-process N=7 tests are not described as multiprocess.
- CI job `consensus-liveness` runs those four files. The main `l1` job runs the full suite.

## Limitations

- The state-space search does not replay every interleaving of P2P delay. There is no dedicated delay/loss/duplication/reorder chaos scheduler. Partition and reconnect coverage is the regression matrix. Anything beyond that is not claimed.
- `tryCompleteSplitRound` completes only round 0. Later unique splits use the view-change path in `produceFinalizedBlock`.
- Rounds above the tested window still use the same rules, but the bounded search stops at 2 rounds.
- Unique-hash completion can still commit a hash that has not gathered a prepare quorum, which is the pre-existing safety rule for a single reachable hash. Those commits do not invent a prepare certificate.
- Happy-path finality costs one extra prepare round-trip.

## Rollback

Redeploy the previous binary only on a network that has not produced a block under these rules. A data directory that already contains `prepare` or `view` journal lines will not load on a binary that rejects those kinds. Do not flip activation flags as a rollback switch. They are unrelated and stay false.

## Public testnet impact

The deployment scaffold, genesis, faucet, TLS, and economics are untouched. The code constant `ROUND0_DOUBLE_HASH_CLASSIFICATION.activation` remains `BLOCKS PUBLIC TESTNET` so the operator gate does not go green by itself. Closing the consensus blocker requires the success conditions in the pull request, including green CI and an independent review. This document does not close that review.
