# ZyronChain deterministic disaster-recovery rehearsal

Status: **pre-public-testnet CI evidence**  
Scope: canonical TypeScript L1 checkpoint backup/restore, suffix catch-up and durable continuation

## Purpose

Recovery code is safety-critical even when ordinary replay and checkpoint unit tests are green. A usable disaster-recovery path must prove that operators can create an authenticated checkpoint with the production CLI, reject a bad external trust anchor without publishing partial state, restore into a new empty data directory, catch up the missing finalized suffix and continue producing durable blocks after restart.

`l1/scripts/disaster-recovery-rehearsal.mjs` is executed as the dedicated `disaster-recovery-rehearsal` job in Standalone L1 CI.

## Rehearsed sequence

The CI rehearsal creates a deterministic two-validator chain and:

1. quorum-authorizes protocol v2 at height 101 and protocol v3 at height 201;
2. finalizes through height 220, including transactions before and after the protocol-v3 signing boundary;
3. runs the compiled `snapshot` CLI against the source data directory at height 220;
4. independently derives the snapshot SHA-256 and finalized tip hash used as restore anchors;
5. continues the source chain through height 240 and retains those finalized blocks as the recovery suffix;
6. attempts `checkpoint-install` with an intentionally incorrect snapshot digest and requires a fail-closed rejection with no published target directory;
7. installs the same checkpoint into a new empty data directory using the correct independently supplied tip and digest;
8. reopens the restored chain and verifies height, tip, protocol schedule, State-v2 balances and nonces;
9. applies the retained finalized suffix through height 240 and requires exact equality with the previously observed canonical state;
10. finalizes a new transaction at height 241 from the recovered node;
11. reopens the recovered directory and requires exact durable tip, state root, protocol version, balances and nonces.

## Invariants checked

The job fails unless:

- backup is produced by the compiled operator CLI rather than a test-only serializer;
- a wrong external snapshot digest is rejected before a target data directory is published;
- the correct checkpoint restores only into a new directory;
- the restored State-v2 state and governance schedule match the checkpoint anchors;
- normal finalized-block validation can catch the restored node up from the checkpoint suffix;
- restored and source histories converge on the exact finalized hash and state root;
- the recovered node can safely continue the chain;
- restart after recovery reproduces the continued state exactly.

## What this does not prove

This deterministic job is executable regression evidence, not a completed production DR exercise. It does **not** replace:

- restoring on different physical/cloud infrastructure;
- independent operators obtaining anchors through separately administered channels;
- measured RTO/RPO under realistic data volume and network conditions;
- loss of a full region/provider;
- production HSM/remote-signer recovery and key-compromise procedures;
- archive/bootstrap service loss and multi-peer catch-up over the public network;
- repeated incident-command and operator-error drills.

Those remain stop-ship evidence requirements in `STANDALONE_L1_READINESS.md` and `L1_OPERATIONS_RUNBOOK.md`.
