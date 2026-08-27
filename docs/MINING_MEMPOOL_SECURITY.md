# Mining mempool security policy

Protocol-v5 mining claims are consensus transactions, but their mempool policy is deliberately separated from ordinary transaction pressure.

## Bounded reserved capacity

The production/default mempool keeps the ordinary non-mining capacity bounded at 10,000 entries and reserves up to 256 additional entries for `mining_claim` traffic. The mining reserve cannot be borrowed by transfers or other transaction kinds. As a result, saturating the ordinary transaction pool cannot by itself prevent a fresh consensus-valid mining claim from entering local policy.

Entry counts are not the only retention bound. The default ordinary subpool also has a 64 MiB aggregate retained-byte ceiling, measured from the deterministic canonical JSON serialization of every resident transaction. The mining subpool has its own independent 4 MiB aggregate retained-byte ceiling. A large otherwise-valid transaction therefore cannot rely on the 10,000-entry count limit to retain unbounded aggregate payload memory, and ordinary traffic cannot consume the mining byte reserve.

Mining traffic remains independently bounded by `MAX_MINING_MEMPOOL_CLAIMS = 256`. Once either the claim-count limit or mining byte budget is full, a new claim can enter only by replacing the weakest mining claim under the deterministic mining-work priority rule and only if the resulting mining subpool remains within its byte ceiling. Mining traffic therefore does not evict ordinary transfers merely to consume its reserve.

Custom `Mempool(maxNonMiningSize)` instances retain a hard total count cap unless an explicit mining reserve is supplied as the second constructor argument. Optional third and fourth constructor arguments can further lower or customize the non-mining and mining retained-byte ceilings. All configured byte capacities must be positive safe integers. The standalone node uses the default production policy: 10,000 ordinary entries / 64 MiB plus a 256-claim / 4 MiB mining reserve.

Mining and non-mining entry counts and retained canonical bytes are tracked incrementally on insertion, deletion, replacement and pruning. Admission therefore does not rescan every resident transaction merely to determine whether a configured capacity has been reached. Byte-accounting invariants fail closed if either subpool would become negative or exceed its configured budget.

Byte pressure does not introduce cascading eviction semantics. One incoming transaction may trigger at most the same single deterministic policy replacement already permitted by the count-based mempool rules. If the projected subpool would still exceed its byte ceiling after that one replacement, admission fails closed instead of deleting additional resident transactions.

When the ordinary pool is saturated by count or retained bytes, the deterministic lowest-priority evictable transfer is cached while mempool contents remain unchanged. Repeated rejected submissions therefore reuse the same bounded replacement decision instead of rescanning the 10,000-entry pool on every request. Every successful insert, deletion, replacement, remove or prune invalidates that cache before the next full-pool replacement decision, so fee-rate and highest-nonce eviction semantics remain identical to an uncached scan.

## Admission and stale-work controls

A mining claim must use exactly the miner account's next confirmed nonce before proof validation. It must also bind to the next height, current finalized tip, deterministic reward schedule, and valid proof target. Finalization removes included transactions and prunes losing claims that no longer match the next height/tip.

These are local DoS/liveness controls. They do not replace the public-testnet activation gates for independent Internet contention testing, RPC abuse testing, mining calibration, validator inclusion/censorship testing, or independent security review documented in `STANDALONE_L1_READINESS.md`.
