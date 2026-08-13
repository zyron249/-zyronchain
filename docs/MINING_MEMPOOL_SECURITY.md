# Mining mempool security policy

Protocol-v5 mining claims are consensus transactions, but their mempool policy is deliberately separated from ordinary transaction pressure.

## Bounded reserved capacity

The production/default mempool keeps the ordinary non-mining capacity bounded at 10,000 entries and reserves up to 256 additional entries for `mining_claim` traffic. The mining reserve cannot be borrowed by transfers or other transaction kinds. As a result, saturating the ordinary transaction pool cannot by itself prevent a fresh consensus-valid mining claim from entering local policy.

Mining traffic remains independently bounded by `MAX_MINING_MEMPOOL_CLAIMS = 256`. Once that subpool is full, a new claim can enter only by replacing the weakest mining claim under the deterministic mining-work priority rule. Mining traffic therefore does not evict ordinary transfers merely to consume its reserve.

Custom `Mempool(maxNonMiningSize)` instances retain a hard total cap unless an explicit mining reserve is supplied as the second constructor argument. When a nonzero reserve is supplied explicitly, that reserve is also the mining subpool cap for that instance, up to the protocol-policy maximum of 256 claims. The standalone node uses the default production policy, which enables the full 256-entry reserve.

Mining and non-mining occupancy are tracked incrementally on insertion, deletion, replacement and pruning. Admission therefore does not rescan every resident transaction merely to determine whether a configured capacity has been reached; full-pool eviction scans occur only when a bounded replacement decision is actually required.

## Admission and stale-work controls

A mining claim must use exactly the miner account's next confirmed nonce before proof validation. It must also bind to the next height, current finalized tip, deterministic reward schedule, and valid proof target. Finalization removes included transactions and prunes losing claims that no longer match the next height/tip.

These are local DoS/liveness controls. They do not replace the public-testnet activation gates for independent Internet contention testing, RPC abuse testing, mining calibration, validator inclusion/censorship testing, or independent security review documented in `STANDALONE_L1_READINESS.md`.
