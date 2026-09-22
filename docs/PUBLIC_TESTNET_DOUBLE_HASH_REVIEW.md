# Round-0 double-hash review

Status: **STOP-SHIP REVIEW**. This document does not change quorum, the reveal threshold, or the signing journal. It does not approve activation.

## What the bound says

Quorum is `floor(2N/3)+1`. The Byzantine bound is `floor((N-1)/3)`. A hash can still have been finalized when `maximumAttestationsPossible` reaches quorum. Unseen validators may all have attested it, and up to `f` contradictory voters may have equivocated.

Bounded enumeration of two visible hashes:

| N | Quorum | f | Reveal threshold | Observations where both hashes can still reach quorum |
|---|---|---|---|---|
| 3 | 3 | 0 | 3 | none |
| 4 | 3 | 1 | 1 | present |
| 7 | 5 | 2 | 1 | present |

For N=4, two hashes with 2 visible attestations each, and every vote seen, both have maximum 3, which is quorum. Completion returns no hash. The same shape exists for N=7. The search finds no case where completion would still select a hash while both remain reachable, and no double-finalization in this model.

N=3 cannot put two hashes both over quorum under this bound, because `f` is 0 and quorum is every validator. That is not an activation approval. The implementation still accepts larger validator sets, and those sets can halt.

## Safety

- At most one completion choice is returned, and only when exactly one hash remains possible and an unseen hash cannot hide a quorum.
- A conflicting journal reservation for the same height and round is refused.
- Certificates are not treated as proof that a hash is impossible while its maximum still reaches quorum.

## Liveness

Ordinary packet loss on one proposal is an attest-versus-skip split. That is not the two-hash case. Two attested block hashes in the same round are possible when two different blocks were signed. On N=4 or N=7 the safety bound then refuses completion, and the reveal threshold of 1 also refuses the uncommitted certificate if any attestation is visible. That height can stay stuck. Class: **possible halt**, not an ordinary single-hash packet-loss path, and not something this deployment patches.

## Designs not taken here

Prepare/commit, prevote/precommit, a locked proposal quorum certificate, or a view-change could give a later round a way to move when two hashes both remain possible. ZyronChain today finalizes with quorum attestations on a proposed block and uses the journal to prevent equivocation. Copying another chain's vote names would not match that evidence format. A safe design has to keep `floor(2N/3)+1`, keep the reveal threshold from declaring a real quorum impossible, and keep the journal append-only.

That work belongs in a **separate consensus pull request**. This deployment pull request does not include it and must not be treated as a merge of that design.

## Classification

**BLOCKS PUBLIC TESTNET.** Activation stays blocked. Limited private rehearsal of the N=3 candidate can continue because the both-hash halt does not appear for N=3 in the bound, and because rehearsal is not a launch. N=4 and N=7 remain a halt if two round-0 hashes are both still possibly final.
