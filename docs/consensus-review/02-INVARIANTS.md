# Safety invariants

Constants: `SAFETY_INVARIANTS` in `l1/src/round-view-change.ts`. The test file `l1/test/consensus-safety-invariants.test.ts` asserts the strings and the quorum formula for N=1..100. `exploreBoundedConsensus` for N=3, N=4, and N=7 asserts zero double finalization, zero conflicting certificates, zero permanent deadlock after the modeled recovery, zero invalid unlock, zero journal loss, and zero liveness failures inside that model. `honestDoubleSign` may be non-zero: those states need an honest double-sign, which the journal rejects.

| Id | Enforcement | Test |
|---|---|---|
| S1 | `validatorQuorumSize` is `floor(2N/3)+1`. No call site passes a smaller quorum. | safety invariants; certificate model |
| S2 | `validateAttestationQuorum` counts finality attestations only. | S9 qualification test; split-vote rejection of a short certificate |
| S3 | Journal slot `height:round` accepts one attest hash. A second throws. | regression equivocation; signing journal tests in `l1.test.ts` |
| S4 | `attestProposal` calls `validatePrepareQuorum` before the commit, except unique-hash completion, which writes no false prepare quorum. | split-vote unique completion; crash test |
| S5 | `commitAllowedByLock` requires `prepareQuorumRound` strictly above every conflicting commit. `prepareProposal` passes null, so a prior conflicting commit blocks a new prepare. | safety invariants unit cases; bounded search `invalidUnlock` |
| S6 | `honestQuorumIntersection = 2Q - N - f >= 1` for accepted N. `N - Q + f < Q`. | safety invariants; bounded search `doubleFinalization === 0` |
| S7 | A view-change quorum that counts a lock must include a prepare quorum for that lock. Honest committers of the earlier quorum do not prepare a conflicting hash. | bounded search; crash test refuses nil after the lock file is removed |
| S8 | `validateRoundCertificate` throws `View-change lock must be finalized before opening a new round` when the certificate's highest lock is non-nil. | block.ts path; produce path finalizes the locked hash in the crash regression |
| S9 | View-change votes are not attestations. A nil certificate that `validateRoundCertificate` accepts still fails `validateAttestationQuorum` with zero attestations. Timeout does not appear in either function as a finalizing input. | `consensus-1-1-qualification.test.ts` |
| S10 | `reservePrepare` / `reserveView` / `reserveAttestation` fsync before the signature returns. Lock file fsync happens before the commit signature in `attestProposal`. | existing journal fsync tests; order described in the changelog; crash regression |

View-change cannot itself finalize. The qualification test builds a quorum of nil view-change votes, accepts them as a round certificate, and shows finality still fails closed at `0/Q`.
