# Limitations

- Self-review of this directory is not independent review. Prefer the label **internal engineering qualification** only when the stated local commands pass.
- `X = f + 1` holds only for the nil-lock, eventually synchronous, round-robin case stated in `03-LIVENESS-BOUND.md`.
- `exploreBoundedConsensus` is not a packet simulator and not a multiprocess run. It covers **N=3, 4, and 7 only** by design.
- Extended qualification includes an in-process chaos matrix (delay, loss, duplication, reorder) plus N=4/N=7 OS-process partition/crash/fresh-sync cases. That is still not a live multi-operator Internet soak.
- `tryCompleteSplitRound` completes only round 0.
- Unique-hash completion can still commit without a prepare quorum. That is the pre-existing single-reachable-hash rule. It must not write a prepare certificate it did not collect.
- Validator-set changes during a view-change are not implemented. Quorum uses `validatorsAt(height)` from the existing schedule (`MIN_VALIDATOR_UPDATE_DELAY` is 100). No governance module was invented.
- N=3 is a legal set size, not a permanent restriction. Public-testnet candidate validators are an empty list awaiting an operator.
- Cohort sizes 3/10/25/50 in extended qualification are **accounting reconcilers**, not 50 OS miners / 50 OS validators.
- Disk rollback onto consensus 1.0 is unsupported after `prepare` or `view` journal lines or lock files exist.
- Checkpoints bind the existing block log and snapshot bytes. They do not version the consensus wire.
- No public testnet, no new hosts, no new keys. Activation flags remain false.
- Gate 1 adversarial unit tests (`gate1-adversarial-consensus.test.ts`) cover unknown-validator rejection, missing-vote non-polarity, 2+2 / 3+3+1 refusal, timeout non-finality, and duplicate-prepare padding — they do not replace independent audit.
