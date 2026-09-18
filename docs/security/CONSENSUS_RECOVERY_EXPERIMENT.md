# Consensus recovery experiment: review boundary

Status: executable model, not a node implementation, not an approved protocol,
and not a public-testnet readiness claim. The production split-vote defect
remains open. No production protocol version or activation height is assigned.

## Why the current rules cannot simply be retried

The real-node evidence in `evidence/consensus-split-vote-2026-09-18.json` contains
opposite durable choices for height 3 / round 0. Retransmitting already-signed
messages cannot create either missing quorum. Resetting journals or allowing
both choices would invalidate the assumptions used by the current safety
tests. The value selected in a later round must instead be justified by a
reviewed cross-round rule.

## Executable candidate

`l1/bench/consensus-recovery-model.ts` explores a single-height,
fixed-membership prepare/commit design. A valid proposal yields prepare votes;
a prepare quorum permits commit votes. A commit quorum decides a value.
View-change promises carry the highest known prepare certificate. The next
proposal must select the highest certified value in a quorum of promises, or
may select a fresh value if none exists. Signing a higher-view promise forbids
later voting in an older view. A valid older commit certificate can still
complete the height.

The reference design distinction between preparation, commitment and transfer
of prepared evidence across views comes from Castro and Liskov's
[PBFT algorithm, sections 4.2 and 4.4](https://www.usenix.org/legacy/events/osdi99/full_papers/castro/castro_html/node4.html).
This reduced model is our own experiment. It is not the complete PBFT
implementation or its correctness proof.

Each model message is authenticated with existing secp256k1 signing utilities
under `zyronchain/recovery-model-only/v1`, bound to chain ID, genesis hash,
height, previous hash, the ordered validator set, phase and view. The model
domain is deliberately incompatible with production signing domains.

The injected persistence callback must acknowledge state before a signature
is returned. An exception permanently stops that replica instance. Tests
cover exceptions both before and after simulated persistence. Recovery uses
trusted simulator snapshots, not the production journal or a hostile-file
parser. Model membership is bounded to 2–16 replicas.

## Validation scope

`l1/test/consensus-recovery-model.test.ts` checks partial preparations and
partial commitments with 2/4/7 members, recovery from simulated snapshots,
equivocating leaders and withholding minorities, duplicate/tampered/cross-chain
certificates, stale messages, persistence exceptions and hidden finality.
It enumerates 64 four-replica schedules formed by prepare-certificate delivery
subsets and new-view quorum omissions. These are bounded tests, not exhaustive
verification of every Byzantine schedule or a network soak.

At `7e909c5d5529b34755fc9ebdde760981bc32f1ff`, all 24 candidate-model tests
passed within the 629-test suites on both Node 22 and Node 24. Evidence:
[Node 22](https://github.com/zyron249/-zyronchain/actions/runs/35369367790/job/105679423459),
[Node 24](https://github.com/zyron249/-zyronchain/actions/runs/35369367790/job/105679423595).
The separate live devnet still failed; it uses the unchanged production rules.

The previous split-vote characterization and quorum-intersection tests remain
unchanged. The live devnet failure remains visible in CI. No production source
imports this model, and no launcher flag enables it.

## Integration work required before deployment

1. Independent consensus review must evaluate the candidate's safety and
   liveness assumptions, certificate selection, hidden finality, Byzantine
   leaders, overlapping views and validator-set transitions. Decide whether
   to integrate a maintained consensus engine instead of this custom design.
2. Specify a versioned block/value identity independent of a retransmitting
   leader's view. Current block hashes include round and proposer; reusing
   them blindly would change the value that a certificate authenticates.
3. Implement bounded wire decoders, certificate size/depth limits, authenticated
   RPC/native-P2P messages, admission budgets and replay protections.
4. Implement durable pending proposals, write-ahead vote/prepare certificates,
   monotonic view promises, compaction and restart validation. Model snapshots
   do not establish POSIX fsync, power-loss or signer-custody guarantees.
5. Extend local and remote signer intent/domain policies, finalized-block and
   light-client verification, checkpoint validation and mixed-version gates.
   Never reuse a production signature domain for different semantics.
6. Add bounded timers, backoff, retransmission, proposal availability and catch-up.
   The model has explicit scheduling; it is not a distributed pacemaker.
7. Run actual multi-process 2/4/7-node crash/partition/rejoin tests, conflicting
   finality attacks, protocol migration tests and independent Internet soak.
   Release and public activation require the existing separate external gates.

## Concrete independent review request

Review the two model files, the production `produceFinalizedBlock`,
`NodeService` signing methods and `SigningJournal`, the existing certificate
safety tests, and the recorded real-node failure. Report counterexamples or
an explicit rationale for cross-view safety and eventual progress under the
stated fault bound. Evaluate the proposed state and value-identity changes
before approving a production implementation or migration. No reviewer,
approval or security-audit outcome is recorded by this document.
