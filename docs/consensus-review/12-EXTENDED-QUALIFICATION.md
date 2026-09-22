# Extended qualification

Consensus production rules were not changed for this file. The runs below were executed in `l1/` with `node --test --test-timeout=180000 --test-reporter=spec dist/test/consensus-extended-qualification.test.js`. Result: 12 pass, 0 fail, duration 20180.889178 ms. Those durations are the runner's figures for that invocation. They are not a capacity plan.

| Test | Runner duration |
|---|---|
| Chaos delay and reorder, one hash | 633.281017 ms |
| Loss then heal | 369.345712 ms |
| Duplicated votes cannot pad quorum | 357.271037 ms |
| Round above catch-up bound | 71.373842 ms |
| Stale replay refused | 270.728465 ms |
| Journal power loss | 19.459118 ms |
| Orphan lock file | 43.735978 ms |
| Mempool bound | 3.251233 ms |
| NodeService protocol v5 delay 100, one mining claim, restart | 15934.594771 ms |
| Cohorts 3/10/25/50 | 179.804529 ms |
| N=4 OS partition, delay, crash, fresh sync | 804.886937 ms |
| N=7 OS partition, delay, crash, fresh sync | 1108.312667 ms |

## What each row actually does

- Delay uses `setTimeout` of 25 ms inside the peer client. Reorder reverses the collected vote array. Loss returns an empty peer response. Duplication repeats that array. A short duplicated set does not finalize. Clearing the fault finalizes one hash.
- The round above `MAX_CONSENSUS_ROUND_CATCHUP` (64) returns null and leaves height 0.
- Replaying an already persisted block throws `Refusing non-sequential block persistence` and leaves the tip unchanged.
- Journal `afterWrite` and `afterSync` hooks throw. The live journal fail-stops. Reopen accepts one hash in the slot and rejects the other.
- A lock file with no journal commit produces a nil view-change and height stays 0.
- Mempool capacity 1 rejects a second transfer with `Mempool full`.
- Three `NodeService` processes finalize heights 1 through 101. Chain header version stays 1 through height 100. Height 101 is chain protocol 5. The block contains one mining claim whose reward is `INITIAL_MINING_REWARD_ATOMS` (6.25 ZYN). Total supply is genesis supply plus that reward. Restart from the same directory reloads height 101 and the same tip. Round-proposal files at heights at or below 101 are gone after finality. The proof search is a real 20-bit loop bounded at 20_000_000 nonces, the same bound as the existing mining test.
- Cohort rows call `runMinerWorkload` for sizes 3, 10, 25, and 50. That function is the accounting reconciler. It is not 50 operating-system miner processes. A reward of 1 atom is `CRITICAL FAIL`.
- OS rows spawn separate processes, directories, keys, and ports. A minority peer set does not finalize. Heal goes through local HTTP proxies that wait 10 ms plus 5 ms per peer before forwarding. One process is `SIGKILL`ed and restarted on the same directory at height 1. A new empty directory accepts that one block and reaches the same tip.

## Bounds written down from the current source

| Bound | Value |
|---|---|
| Quorum | `floor(2N/3)+1` |
| Round catch-up | 64 |
| HTTP body | 2_500_000 bytes |
| View-change prepare list | 100 |
| Validator set cap | 100 |
| Non-mining mempool count / bytes | 10_000 / 64 MiB |
| Mining mempool claims / bytes | 256 / 4 MiB |
| Native consensus frame | 2_500_000 bytes |
| Native rate / inflight / outstanding | 240 per 60 s / 2 / 32 |
| Recovery checkpoint file | 65 MiB |
| Finalized history retain count | integer from 0 through the persisted height |

## Not an independent review

No third-party review findings exist in this repository. Phase 12 has nothing to apply. The next human gate is an independent consensus reviewer.
