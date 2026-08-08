# ZyronChain Mainnet Readiness

This document is the engineering gate, not a marketing claim. "Real blockchain" means nodes
independently validate the same deterministic ledger, invalid value creation is impossible
under the protocol rules, keys are never entrusted to the node, peers cannot bypass validation,
and operators can detect/recover from failures. Mainnet launch additionally requires external
evidence that cannot be created by code changes alone.

## A-Z audit

| Area | Current state | Mainnet gate |
|---|---|---|
| Amount arithmetic | DONE in v3 | Integer atoms everywhere in new consensus |
| Block commitment | DONE in block v2 | Integer timestamp + Merkle commitment |
| Chain identity | DONE for testnet | `zyron-testnet-1` checked during peer sync |
| Cryptography | DONE for current protocol | libsecp256k1 backend; low-S; deterministic vectors |
| Duplicate/replay control | DONE | chain-wide txid uniqueness, nonce ordering, chain_id |
| External input limits | DONE baseline | body, block, mempool and peer-response bounds |
| Fees and issuance | DONE | exact subsidy+fees; fees excluded from minted supply |
| Genesis | DONE for testnet | fixed timestamp/hash validation |
| Historical compatibility | DONE | v1/v2 transaction and legacy block validation retained |
| Integer time | DONE for new data | v3 tx and v2 block timestamps use integer ms |
| Key custody | DONE baseline | server wallet/recovery disabled; browser-only keys |
| Legacy shadow code | DONE | unsafe duplicate implementation removed |
| Mempool | DONE baseline | size/TTL/fees/nonces/balance/version checks |
| Node administration | DONE baseline | admin token + POST/rate limits |
| Orphan/reorg handling | DONE baseline | cumulative work + orphan transaction recovery |
| Persistence | DONE baseline | validated load; atomic suffix/reorg writes; peer reputation |
| Query/API safety | DONE baseline | validation, size limits, secret non-leak |
| Runtime concurrency | DONE baseline | serialized in-process mutations |
| Supply chain | DONE baseline | vulnerable Python ecdsa removed; wallet crypto vendored |
| Tests | DONE baseline | consensus/security/multi-node regression suite |
| Upgrade versioning | DONE baseline | transaction v3 and block v2 are explicit |
| Validation determinism | DONE baseline | canonical payloads + fixed cross-language vector |
| Wallet address binding | DONE | public key must derive sender address |
| eXplorer/operator API | DONE baseline | health/network/supply/mempool/explorer surfaces |
| Yield/fork choice | DONE baseline | strictly greater cumulative proof-of-work |
| Zero-trust peer data | DONE baseline | remote chain/mempool fully revalidated |

## P0 gates before a public mainnet

These are intentionally not marked complete merely because the application runs.

1. **Protocol activation rule/checkpoint.** Legacy block headers are still historically accepted.
   A public mainnet needs an immutable activation height/hash (or a fresh mainnet genesis) so an
   alternative legacy-only history cannot avoid newer consensus rules.
2. **Headers-first/incremental synchronization.** The current node validates full candidate chains
   and therefore has bounded individual peer responses but not production-grade headers-first,
   staged block download, checkpoints, pruning or fast sync.
3. **Indexed consensus state.** Balance and nonce reconstruction still scan chain history. A
   long-lived network needs an atomically committed account/state index, rebuild checks and a
   state commitment strategy.
4. **Peer-layer Sybil/eclipse resistance.** HTTPS/SSRF validation, reputation, peer limits and
   blacklist are useful but are not a decentralized peer discovery/security protocol. Add node
   identity, network/protocol handshake, diversity rules and trusted bootstrapping policy.
5. **Timestamp/retarget hard-fork rules.** New integer timestamps remove representation ambiguity,
   but public launch should activate median-time-past/time-warp-resistant difficulty rules at a
   fixed protocol boundary.
6. **Long-running adversarial testnet.** Run multiple independently hosted nodes through reorg,
   partition, restart, database restore, clock skew, malformed peer, high-mempool and upgrade tests
   for a defined soak period.
7. **Independent security review.** Consensus, cryptography, wallet and networking require review
   by people who did not author the implementation. Findings must be closed before value is put at
   risk.
8. **Release/operations discipline.** Reproducible locked dependencies, signed releases, protected
   main branch, backups/restore drills, monitoring/alerts, incident response and operator runbooks
   must exist before launch.

## P1 hardening after the P0 architecture

- versioned/checksummed mainnet addresses and explicit testnet/mainnet address separation
- encrypted local keystore and HD-wallet standard with documented recovery interoperability
- transaction/state proofs and a light-client/SPV story
- schema migrations with tested rollback/restore instead of only idempotent table creation
- metrics/tracing for block validation, fork choice, peer quality, mempool and persistence latency
- property-based/fuzz tests for parsers, serialization, reorgs and monetary invariants
- dedicated miner process/API so proof-of-work never occupies the HTTP application worker
- protocol specification vectors implemented by a second independent node/client

## Launch rule

Do not label ZyronChain "100% mainnet-ready" until every P0 gate has objective evidence. Passing
unit tests proves specific invariants; it cannot prove the absence of consensus or security bugs.
