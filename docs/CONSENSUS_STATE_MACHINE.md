# ZyronChain consensus state machine

Status: forensics of the pre-round-change machine at `49b6002`, then the prepare/commit machine this branch implements. Quorum stays `floor(2N/3)+1`. This document is not an activation approval.

## Actors and clocks

A height finalizes at most one block hash. The proposer for `(height, round)` is

`validators[((height - 1) + round) mod N]`.

Time is measured from the previous block timestamp:

- round `0` opens at `BLOCK_INTERVAL_MS` (30s);
- round `r` opens at `BLOCK_INTERVAL_MS + r * ROUND_WINDOW_MS`;
- a skip or view-change for round `r` is signed only at or after the opening of round `r + 1`.

`produceFinalizedBlock` anchors the proposal timestamp to one clock sample. Signing uses a fresh sample when the caller does not inject `nowMs`. Rounds above `MAX_CONSENSUS_ROUND_CATCHUP` (64) fail closed.

## Messages (baseline `49b6002`)

| Message | Signature domain | Journal slot | Effect |
|---|---|---|---|
| Proposal | `zyronchain/block-proposal/v1` | `attest` of the proposal hash, written before the signature is returned | Binds the proposer to one hash for that round |
| Attestation | `zyronchain/finality-attestation/v1` | same `attest` slot | **This signature is the commit.** `Q` of them finalize |
| Skip | `zyronchain/round-skip/v1` | `skip` of the previous hash, same slot as attest | Mutually exclusive with attest |
| Locked-attest evidence | re-signed attestation plus header | read-only replay of an `attest` slot | Carried in an uncommitted-round certificate |
| Round report | none (replays the journal) | none | Tells a peer the existing choice |
| Completion attestation | same finality domain | `attest` at round `r` or, for a skipper, at round `r+1` | Used only when exactly one hash remains possibly final |

`Q = floor(2N/3)+1`. Byzantine allowance used by the bounds is `f = floor((N-1)/3)`.

Finalization is `validateAttestationQuorum`: `Q` distinct valid attestations on one hash. Nothing else finalizes. A timeout does not finalize.

## Round advance (baseline)

A block with `round > 0` must carry a progress certificate for round `r-1`. That certificate is one of:

1. **Skip quorum.** `Q` skip votes, no attestations.
2. **Uncommitted-round certificate.** `Q` votes mixed from skips and locked attestations, and every hash is strictly below `uncommittedAttestationRevealThreshold`.

The reveal threshold is `2Q - N - f`, and it is at least 1. It is the minimum number of honest attestations of a finalized hash that must still be visible inside any other quorum if at most `f` voters hide. For N=4 and N=7 the threshold is 1, so any visible attestation blocks this certificate.

There is no third way to open round `r+1`.

## Possible-quorum bound (baseline)

`maximumAttestationsPossible(visible, votesSeen, N) = visible + unseen + min(f, contradictory)`.

`hashCouldStillBeFinalized` is that quantity compared with `Q`. Unseen validators may all have attested the hash. Up to `f` voters who showed a different choice may have equivocated.

`uniquePossiblyFinalizedHash` returns a hash only when:

- an unseen hash cannot itself reach `Q`, and
- exactly one visible hash still can.

Otherwise it returns null. `tryCompleteSplitRound` then returns null. It does not open a later round.

## Equivocation and the journal (baseline)

The signing journal is an append-only NDJSON file. A reservation is fsynced before the matching signature is returned. One slot `(height, round)` holds either `attest:hash` or `skip:previousHash`. A second choice fail-stops that attempt. A crash during the append fail-stops the process; replay on restart is the only recovery. Conflicting history in the file is rejected.

Honest nodes therefore cannot attest two hashes, or attest and skip, in one slot. Byzantine nodes can still publish two signatures produced outside the journal. Observers drop a validator whose visible votes disagree. Those signatures remain cryptographically valid inside a certificate that never saw the conflict.

## Why N=4 and N=7 halt

Completion is safety-conservative: it will not pick a hash while two hashes can both still reach `Q` under the per-hash bound. For a full observation of 2 and 2 on N=4 (`Q=3`, `f=1`), each side's maximum is `2+0+1=3`. The same shape exists on N=7 (`Q=5`, `f=2`) for several splits, including 3 and 3. `uniquePossiblyFinalizedHash` is null.

The uncommitted certificate is also unavailable, because the reveal threshold is 1. Attesters cannot skip: the journal slot is taken. No later proposal can be formed. The height stays at the parent forever, including after the network becomes synchronous and every honest validator is responsive.

N=3 has `f=0` and `Q=3`. No observation puts two hashes both at or above `Q`. The class there is `impossible-under-bound`, not a proof that a later bug cannot exist.

Any two real quorums intersect in `2Q-N` validators, and `2Q-N-f >= 1`, so two finality quorums would require an honest double-sign. The baseline search does not find a double finalization. The failure is liveness, not a known safety break. Classification at `49b6002`: **BLOCKS PUBLIC TESTNET**.

## Restart, stale, and future (baseline)

Restart loads the chain store and replays the journal. A reserved attest is re-signed; it is not replaced. Blocks more than 120s ahead of the local clock are rejected. Round catch-up above 64 rounds is rejected before any skip is signed. A backward validator clock beyond 1s fail-stops signing until process restart.

## P2P and HTTP (baseline)

HTTP routes: `/proposal/attest`, `/round/skip`, `/round/lock`, `/round/report`, `/round/complete`, `/block`. Native streams use `/zyronchain/consensus/1.0.0` with the same verbs. Public RPC classifies these as consensus and does not serve them. Peer signatures are checked against the active validator set. Response shapes are exact-key and byte-capped.

## Prepare/commit machine (this branch)

The attestation above was doing two jobs. This branch splits them.

| Phase | Domain | Journal | Finalizes? |
|---|---|---|---|
| Prepare | `zyronchain/round-prepare/v1` | `(height,round)#prepare` | No |
| Commit | `zyronchain/finality-attestation/v1` (unchanged) | `(height,round)` kind `attest` | Yes, at `Q` commits |
| View-change | `zyronchain/round-view-change/v1` | `(height,round)#view` | No |
| Skip | unchanged | unchanged, and it conflicts with a prepare in that round | No |

A validator commits a hash only after a prepare quorum for that same hash and round, or through the existing unique-hash completion path whose bound already shows every other hash is impossible. A view-change carries either a nil lock or the highest commit together with one prepare quorum that justifies it. Timeout and view-change never finalize.

A later-round block may embed a view-change certificate only when that certificate's highest lock is nil. If any valid lock is present, the original locked block is finalized by gathering commit signatures. It is not replaced by a new hash.

Native consensus moves to `/zyronchain/consensus/1.1.0`. Mixed binaries with `1.0.0` are not supported. See `docs/CONSENSUS_ROUND_CHANGE_DESIGN.md` and `docs/CONSENSUS_SAFETY_LIVENESS_REVIEW.md`.
