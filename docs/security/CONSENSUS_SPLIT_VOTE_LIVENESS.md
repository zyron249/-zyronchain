# Open consensus liveness blocker

Status: unresolved; public-testnet activation must remain disabled.

## Deterministic certificate counterexample

`l1/test/consensus-split-vote-model.test.ts` exercises real proposal creation,
cryptographic signatures and certificate validation for 2, 4 and 7 validators.
The proposer and one group attest a round-0 proposal. Before receiving it, the
remaining group votes to skip round 0 after its deadline. Both groups have
fewer than `floor(2*n/3)+1` votes, despite all validators being honest.

The signing journal permits only the first `attest:<hash>` or
`skip:<previousHash>` choice for a height/round. Re-delivery cannot increase
either disjoint set of eligible signers. Duplicate messages cannot count as
additional validators. Consequently neither finality nor the first skip
certificate required by subsequent rounds is available in this history.
Increasing the validator count alone does not remove this counterexample.

Passing these characterization tests means the counterexample was reproduced,
not that liveness was repaired. Positive controls use separate hypothetical
histories and verify genuine quorums remain accepted. The model does not test
transport, real processes, disk persistence or crash recovery.

## Connection to the observed failure

The real two-validator CI run at
`b33942fbb1dc6017b50f10f3200afed44ed535b3` stalled at height 2 after a validator
restart: https://github.com/zyron249/-zyronchain/actions/runs/35363386851/job/105659868454

The model proves an available protocol-level deadlock, but does not establish
that the CI failure followed this exact voting history. Existing diagnostics
did not retain the corresponding journal choices. Both facts must remain
distinct in readiness reports.

### Confirmed real-node reproduction

The subsequent run at `8cc0621e8edbd23313f53427b561ec8e1712bd26`
captured the actual persisted choices after the same restart exercise:

| Validator | Finalized height | Reserved height / round | Choice |
| --- | --- | --- | --- |
| A | 2 | 3 / 0 | attest |
| B | 2 | 3 / 0 | skip |

Both tips were `170af593f0899be521ed78acd97908c3f02ce5323d8ff29c617e2e5efbca4b8d`.
Persistence and clocks were healthy; both mempools were empty. The last
finalized block was 156 seconds old. The bounded journal readers reported no
omitted or rejected records. This confirms the split-choice deadlock in this
run, rather than inferring it from a timeout alone. The first of three planned
fresh-network runs failed; the other two did not execute.

Evidence: [real-node CI job](https://github.com/zyron249/-zyronchain/actions/runs/35366853429/job/105671301746)
and [sanitized observations](evidence/consensus-split-vote-2026-09-18.json).
Node 22 and 24 each passed 605 tests at this SHA; the four diagnostic-reader
tests also passed on Linux. No recovery fix is claimed.

There is also a proposal-retry gap: `produceFinalizedBlock` builds a new proposal
with the current timestamp on each attempt. A failed attempt has already
reserved the previous proposal hash. The existing four-validator partition
test retries using the identical timestamp; it does not establish recovery
when wall time or pending transactions change. Durable proposal retransmission
would address that gap but cannot by itself recover an attest/skip split.

## Required resolution and evidence

Do not erase journals, allow conflicting first choices, reduce quorums, skip
the failed devnet check or extend timeouts as a purported consensus fix.

A recovery design must specify what evidence permits changing a lock, how a
previously finalized value remains protected, and how delayed proposals and
certificates are handled. A versioned prepare/commit and view-change protocol
is a candidate for design review, not an implemented or verified solution.
Its wire format, signature domains, persistent state and mixed-version rules
need explicit specification and independent consensus/security review before
public activation.

Acceptance requires deterministic real-node cases for partial proposals,
attest/skip splits, advancing time and changed mempools, delayed certificates,
restart at every persistence/signature boundary, and partition healing with
2/4/7 validators. Every case must retain conflicting-finality rejection while
eventually producing a common tip after connectivity and quorum recover.
Run the existing safety models, mixed-version and crash tests, repeated real
devnets, and the separately required independent Internet soak afterward.
None of those missing results is supplied by this document.
