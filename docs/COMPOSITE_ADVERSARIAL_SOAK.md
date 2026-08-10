# ZyronChain composite adversarial consensus soak

Status: **pre-public-testnet deterministic CI evidence**  
Scope: long-running composition of consensus, protocol-transition, partition/catch-up and validation faults

## Purpose

ZyronChain already has focused regressions for view changes, partitions, clock skew, replay, crash recovery and quorum validation. Focused tests can still miss state interaction bugs that appear only after many faults and protocol transitions are composed on one history.

`l1/scripts/composite-adversarial-soak.mjs` runs a deterministic 600-height history against one canonical chain and four independent verifier replicas. It is executed as a dedicated Standalone L1 CI job.

## Scenario

The soak:

- starts with four validators, requiring three unique finality attestations;
- quorum-authorizes protocol v2 at height 101 and protocol v3 at height 201;
- finalizes 600 consecutive heights while transfers continue across both activation boundaries;
- forces a certified round-0 → round-1 view change every 11th height;
- repeatedly withholds finalized blocks from one rotating replica for seven-block partition windows, then requires deterministic suffix catch-up;
- repeatedly presents otherwise valid conflicting proposals with only two finality signatures and requires rejection;
- repeatedly injects duplicate finality voters and requires rejection;
- repeatedly replays an already finalized block and requires rejection;
- repeatedly presents correctly signed proposals more than the allowed future-clock window ahead and requires rejection;
- periodically replaces a synchronized replica from an independently anchored trusted snapshot and requires exact convergence;
- continuously compares finalized tip, state root, protocol version, balances and nonces between the canonical history and active replicas;
- catches every partitioned replica up at the end and requires all four to reproduce the exact height-600 state.

## Minimum evidence thresholds

The 600-height run must contain at least:

- 50 certified view changes;
- 40 insufficient-finality rejection attempts;
- 20 duplicate-attestation rejection attempts;
- 30 finalized replay rejection attempts;
- 15 future-clock rejection attempts;
- eight trusted-snapshot restart recoveries;
- 80 withheld partition deliveries followed by recovery.

The final protocol must be v3 and every replica must reproduce the canonical finalized hash, state root, balances and nonces.

## Limits

This test intentionally does not claim to close the sustained public-network gate. It operates multiple independent chain replicas inside one CI process and therefore does not emulate:

- real TCP/Noise/yamux scheduling, packet loss, bandwidth pressure or NAT behavior;
- separate hosts, regions, providers, operators or validator signers;
- process-level SIGKILL/disk faults while a partition is active;
- malformed public RPC/P2P traffic during the same long history;
- real eclipse/Sybil control of discovery and routing during consensus faults;
- a Byzantine validator possessing enough independently controlled keys to violate the stated quorum assumption.

Those remain public-testnet stop-ship evidence. The value of this job is to make long-lived cross-fault state interaction a required deterministic regression before those external rehearsals begin.
