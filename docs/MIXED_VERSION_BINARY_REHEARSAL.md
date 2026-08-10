# ZyronChain mixed-version binary rehearsal

Status: **pre-public-testnet CI evidence**  
Scope: canonical TypeScript L1 protocol upgrade/rollback compatibility  
Historical binary: `35349589c12a0882d7c2c034cfee520ea9efb3bb` (`Prove durable State-v2 rollback recovery`), the fixed main commit immediately before protocol v3 activation support.

## Purpose

A protocol activation must not rely only on unit tests in the newest binary. Operators need evidence that a real previously released-capable binary follows the same finalized history while it still supports the active protocol, then fails closed at the exact height where an unsupported protocol becomes active.

`l1/scripts/mixed-version-rehearsal.mjs` is run by the required Standalone L1 CI workflow. CI builds both the current source and the fixed historical pre-v3 source from their locked dependencies and executes them against one deterministic history.

## Rehearsed sequence

The deterministic rehearsal creates a two-validator chain and quorum-authorizes three protocol schedule entries in protocol v1:

1. protocol v2 activates at height 101;
2. protocol v3 activates at height 201;
3. an independently scheduled rollback to protocol v1 activates at height 301.

The current and historical binaries both validate and finalize the exact same v1 and v2 blocks through height 200, including a State-v2 transfer after v2 activation. Their height, finalized tip hash, state root, balances and nonces must remain identical.

At height 201 the current binary produces and validates the first protocol-v3 block. The historical pre-v3 binary must reject that block with `Protocol version 3 is not supported by this binary` and must remain at height 200. Advancing the historical binary past the unsupported activation is a test failure.

The rehearsal then models an operator rolling that stopped node to the current binary. The current binary restores the historical node's authenticated height-200 snapshot, accepts the exact v3 activation block and must converge to the already-upgraded node.

Both upgraded nodes continue through protocol v3, execute a domain-separated v2 transaction, cross the scheduled height-301 rollback into protocol v1, execute a legacy transaction after rollback, and reproduce the same finalized tip/state. A final trusted-snapshot restart must preserve the post-rollback state and protocol schedule.

## Invariants checked

The CI job fails unless all of the following hold:

- old and new binaries are deterministic through every mutually supported protocol height;
- the historical binary fails closed before accepting any unsupported-v3 state transition;
- the stopped historical node does not advance its finalized height;
- replacing the stopped binary with the current binary from authenticated pre-activation state converges exactly;
- v3 transaction semantics remain valid after the rolling upgrade;
- the pre-authorized State-v2-to-v1 rollback executes at the exact scheduled height;
- legacy transaction semantics resume after rollback;
- post-rollback restart reproduces the exact tip, state root, balances and nonces.

## What this does not prove

This is deterministic binary-compatibility evidence, not public-network launch authorization. It does **not** replace:

- sustained mixed-version operation across independently administered machines;
- real network delay, packet loss, partitions and sequential view changes during rollout;
- operator error and rollback timing drills;
- production signer/HSM behavior;
- multi-region checkpoint restore and disaster recovery;
- independent consensus/security review.

Those remain public-testnet/mainnet stop-ship gates in `STANDALONE_L1_READINESS.md` and `L1_OPERATIONS_RUNBOOK.md`.
