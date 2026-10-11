# Consensus round catch-up: bounded work, no permanent halt (F-02)

Legacy validator production (protocol v1-v5) derives the consensus round from the elapsed wall-clock time since the local chain tip. A block at round `R > 0` must carry a quorum skip certificate for round `R - 1`, and a validator signs a skip vote for round `r > 0` only with a quorum certificate for `r - 1` and only after the round-`r` deadline has elapsed on its own clock. Reaching round `R` therefore needs a skip-certificate chain for every round `0..R-1`: the work to resume after a stall is inherently proportional to the stall length.

## Previous behaviour (removed)

`produceFinalizedBlock()` built the whole chain in one call and refused any derived round above `MAX_CONSENSUS_ROUND_CATCHUP` (64). After `BLOCK_INTERVAL_MS + 65 * ROUND_WINDOW_MS` (about 33 minutes) without a finalized block, every validator refused on every tick forever; restarts did not help and no transaction could fix it (audit finding F-02).

## Current behaviour

- The target round is always the wall-clock round. The validator never clamps to a different round or proposer.
- The highest verified skip certificate for the current tip (height and previous hash) is kept in the `NodeService` (memory only). One producer call extends the chain by at most `MAX_CONSENSUS_ROUND_CATCHUP` (64) rounds and within `MAX_CONSENSUS_CATCHUP_WORK_MS` (15 s) of wall time, so per-tick work stays bounded.
- While the wall-clock round is more than one call's reach ahead of the chain ("catching up"), every validator extends its own chain, so whichever validator is the proposer when its chain reaches the wall-clock round can propose immediately. Within one call's reach, only the expected proposer works, exactly as before.
- After a restart the in-memory progress is lost. Re-requesting skip votes for already reserved rounds is idempotent in the signing journal (same height, round and previous hash).
- `/readyz` reports `consensus-catching-up` while a validator is catching up, and `stale-tip` once the finalized tip is older than the readiness bound (see the operations runbook).

Block validity, block hashing, skip-vote payloads, the predecessor-certificate rule, quorum validation and the signing-journal anti-equivocation rules are unchanged.

## Recovery time

With one 30 s legacy tick, the chain advances by up to 64 rounds per tick while the target moves by one round. Approximate time to the first block after all validators are back: 40 minutes of stall, about 1-2 ticks; 1 day, about 46 ticks (~23 min); 7 days, about 320 ticks (~2.7 h). Each skipped round costs one fsynced journal row per validator, compacted when the height finalizes.

Protocol v6 does not use skip-certificate chains: the leader of round `r` needs only a timeout certificate for `r - 1`, so v6 resumes after a long stall with constant work per round (rounds are capped at 120 s; `V6_MAX_ROUND` corresponds to roughly 3.8 years of failed rounds).

## Clock faults

A validator whose clock runs ahead cannot make honest peers skip live rounds: each peer checks the round deadline against its own clock and refuses, so the faulty validator's chain stops at the first round its peers still consider live. Its own journal can reserve at most that one extra round, which only affects its own participation in that round (the same exposure as before this change).

This control is not evidence that public testnet or mainnet activation criteria have been met. Existing readiness and activation gates remain authoritative.
