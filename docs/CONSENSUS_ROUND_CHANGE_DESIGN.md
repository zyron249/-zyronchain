# Round-change design

Status: design chosen before the code on this branch. Quorum stays `floor(2N/3)+1`. No hash is finalized by timeout, by plurality, or by assigning unseen validators.

## Safety target

S-final: at most one finalized hash at a height.

The baseline already refuses completion when two hashes are both still possibly final. That refusal is kept. The hole is that the refusal never ends.

## Liveness target

After the network is eventually synchronous, at most `f = floor((N-1)/3)` validators are faulty, and every honest validator answers in the round it is in:

an ambiguous prepare split that produced no commit quorum is followed by a finalized hash within `X = f + 1` further rounds.

`X` is the worst-case run of Byzantine proposers before the round-robin proposer is honest. It is not a tuned timeout.

## Approaches

### A. Prepare then commit (PBFT-shaped, two phases)

Validators prepare one hash per round. A prepare quorum is not final. A commit is signed only after that quorum and uses the existing finality-attestation signature. `Q` commits finalize. On timeout, a view-change vote carries the commit lock or nil. A new proposal is legal only for a nil lock. A non-nil lock finishes the already-proposed block.

| Axis | Score |
|---|---|
| Safety | Strong. Two commit quorums intersect in an honest validator. A commit quorum's honest signers appear in every later view-change quorum (`2Q-N-f >= 1`) |
| Liveness | The 2-2 / 3-3 prepare split has no commit and no lock, so the next honest proposer finalizes a fresh block |
| Complexity | One extra phase on the happy path. Reuses attestation verification, journal fsync, and block finality checks |
| Journal | New prepare and view slots. Commit stays the existing `attest` slot. Write-before-send unchanged |
| Messages | Happy path: proposal, prepare, commit. Split path adds one view-change round |
| Latency | One added round-trip before finality on the happy path |
| Mixed-version | Not safe against binaries that still treat the first vote as a commit. Protocol id must change |
| Upgrade | Homogeneous upgrade before any height is produced. No activation flag |
| Recovery | Commit hash is in the journal. The prepare quorum that justified it is fsynced beside it |
| Tests | Old unique-hash completion and skip quorum stay. New N=4 and N=7 regressions |

### B. Tendermint prevote / precommit lock

Prevote, then precommit, then decide. Nil votes are first-class. Locks move only for a higher-round polka. This is the textbook fix and it is what approach A implements in ZyronChain's names (prepare = prevote, commit = precommit, view-change carries the lock). A literal second stack of message names beside the existing attestation would duplicate verification.

### C. HotStuff QC plus pacemaker

A quorum certificate is hashed into the next proposal and a pacemaker rotates views on timeout. Safety is the same intersection argument. The chain would grow QC links inside headers and would stop embedding the predecessor certificate in `roundCertificate`. That is a larger format change than this bug needs, and it still needs the same lock rule.

### D. Highest safe certificate forced into every new-round proposal

The next proposer must repropose the hash of the highest prepare quorum, even when that quorum is only "possible" under the equivocation bound. On a 2-2 split there is no such quorum. Picking either visible hash anyway is the banned plurality rule. Rejected as a standalone fix. Approach A uses a real prepare quorum as the only lock, which is the safe special case of this idea.

### E. Unlock only with a higher-round quorum certificate

Necessary companion to A, not a standalone liveness fix. An honest validator who committed `H` at round `r` refuses `H'` until a prepare quorum for `H'` exists at a round `> r`. That quorum cannot be assembled if `H` already has a commit quorum, because the intersection contains an honest committer who will not prepare `H'`.

## Choice

**Approach A, with the lock/unlock rule from E.** It is the smallest change that keeps ZyronChain's finality attestation, quorum, journal, and skip certificate, and that gives the ambiguous split a finite nil-lock view-change.

Rejected shortcuts, all of which fail the safety bar:

- lowering quorum or the reveal threshold;
- hard-coding N=3;
- finalizing the hash with the most prepares when the round times out;
- treating missing votes as votes against a hash;
- deleting equivocation checks or accepting two finalized hashes.

## Lock and view-change rules

1. Prepare at most one hash in a round. A prepare conflicts with a skip in that round.
2. Commit at most one hash in a round. The commit signature is the existing finality attestation.
3. Commit only if a prepare quorum for that hash and round verifies, except the pre-existing unique-hash completion path, which already proves every other hash cannot reach quorum.
4. A view-change for the round being left is nil when the validator has no commit at that height. Otherwise it carries the highest commit and one prepare quorum for it.
5. A view-change quorum with a verified lock does not justify a new hash. Peers commit the locked block.
6. A view-change quorum whose locks are all nil is a valid predecessor certificate for a new proposal. The new proposal still needs its own prepare quorum and commit quorum.
7. Two locks at the same round for different hashes, both with valid prepare quorums, make the certificate invalid. The node does not pick one.
8. Journal append plus fsync happens before any of these signatures is returned. Lock-certificate bytes are fsynced before the commit signature.

## Mixed version

Not supported. `/zyronchain/consensus/1.0.0` nodes sign a finality attestation as their first vote. Running them beside this binary can both stall and, if the old nodes reach a commit quorum on a different hash than the new nodes, fork. The native protocol id is `/zyronchain/consensus/1.1.0`. Block header version is unchanged because finality is still a quorum of the same attestation domain. Activation flags stay false. Economics stay 50M / 6.25 / 4M / 20-bit / 1 claim per block.
