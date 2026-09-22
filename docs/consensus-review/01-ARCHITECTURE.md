# Architecture

The baseline machine at `49b6002` used one signature, `zyronchain/finality-attestation/v1`, as both the round vote and the commit. Completion returned null when two hashes could both still reach quorum. That null was safe. No later round could open, because attesters could not skip and the reveal threshold blocked an uncommitted certificate. N=4 with 2+2 and N=7 with 3+3+1 halted.

This branch inserts a non-final prepare and a non-final view-change. The commit signature is unchanged.

```
prepare (journal #prepare, not final)
    -> prepare quorum Q
        -> commit (journal attest, finality attestation)
            -> Q commits finalize one hash
timeout of an ambiguous round with no commit quorum
    -> nil view-change
        -> next round-robin proposer may propose a new hash
timeout when a commit quorum already exists
    -> view-change names that lock
        -> peers commit the original hash
        -> a new hash is rejected while the lock is non-nil
```

Proposer for `(height, round)` is `validators[((height - 1) + round) mod N]`. Round `r` may be signed for skip or view-change only at or after `previousTimestamp + BLOCK_INTERVAL_MS + (r + 1) * ROUND_WINDOW_MS`.

`tryCompleteSplitRound` still looks only at round 0. If that round has a unique possibly-final hash, it can still finalize without a view-change. If it does not, `produceFinalizedBlock` walks predecessor certificates, which may be a skip quorum or a nil view-change, and proposes the next round.

A view-change quorum is not a finality quorum. `validateAttestationQuorum` counts only `block.attestations`.

Validator-set changes are not part of this machine. `validatorsAt(height)` is the pre-existing schedule. No new governance transaction was added.
