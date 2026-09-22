# Liveness bound

`roundChangeLivenessBound(N) = floor((N - 1) / 3) + 1 = f + 1`.

## Derivation

Assumptions, all required:

1. Proposer of round `r` at height `h` is `validators[((h - 1) + r) mod N]`.
2. At most `f = floor((N - 1) / 3)` validators are Byzantine.
3. After the ambiguous round, the network is synchronous enough that every honest validator answers the honest proposer.
4. The ambiguous round has no commit quorum, so the view-change lock is nil.
5. Honest validators sign that nil view-change. Honest count `N - f` is at least `Q`, so the view-change certificate can form.

Under those assumptions the next `f` proposers can each be Byzantine and burn one round. Proposer `f + 1` is honest. That honest proposer collects a nil certificate, proposes one new hash, collects a prepare quorum, and collects a commit quorum.

N=4: `f = 1`, `X = 2`. N=7: `f = 2`, `X = 3`. N=3: `f = 0`, `X = 1`. The N=3 case is not the bug. The bug was N=4 and N=7.

## What the bound is not

- It is not a proof of every message schedule.
- It is not a proof under clock faults. A validator clock more than 1s behind fail-stops signing until process restart. Blocks more than 120s ahead of the local clock are rejected. Rounds above 64 fail closed.
- It does not apply when a commit quorum already exists. Liveness there is `finalizeLockedHash` on that hash.
- `exploreBoundedConsensus` checks the nil-view-change model for two rounds and the listed partitions. It does not replay the old halt, and it is not a packet-level simulator.
- The OS-process tests show one honest proposer (index 1, which is the round-1 proposer at height 1) finishing inside `X + 1` rounds after a full split. They do not enumerate every Byzantine proposer sequence.

If a later review finds a schedule that stays stuck forever while those five assumptions hold, that is a concrete bug and the bound must be withdrawn.
