# Limitations

- Self-review of this directory is not independent review.
- `X = f + 1` holds only for the nil-lock, eventually synchronous, round-robin case stated in `03-LIVENESS-BOUND.md`.
- `exploreBoundedConsensus` is not a packet simulator and not a multiprocess run.
- No delay/loss/duplication/reorder chaos scheduler was added.
- `tryCompleteSplitRound` completes only round 0.
- Unique-hash completion can still commit without a prepare quorum. That is the pre-existing single-reachable-hash rule. It must not write a prepare certificate it did not collect.
- Validator-set changes during a view-change are not implemented. Quorum uses `validatorsAt(height)` from the existing schedule (`MIN_VALIDATOR_UPDATE_DELAY` is 100). No governance module was invented.
- N=3 is a legal set size, not a permanent restriction. Public-testnet candidate validators are an empty list awaiting an operator.
- Disk rollback onto consensus 1.0 is unsupported after `prepare` or `view` journal lines or lock files exist.
- The protocol-v5 chain rehearsal that uses `ZyronChain.attestBlock` does not exercise prepare/commit. A 101-height `NodeService` rehearsal was not run.
- Checkpoints bind the existing block log and snapshot bytes. They do not version the consensus wire.
- No public testnet, no new hosts, no new keys.
