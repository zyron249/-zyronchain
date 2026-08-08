# ZyronChain Mainnet Readiness and Adversarial Audit

Date: 2026-08-08

Scope: the standalone TypeScript L1 (`l1/`) and the operational/release surfaces required to run it as an independently verifiable public network. Legacy Python/Flask code is not treated as the target consensus implementation.

## Executive conclusion

ZyronChain is no longer just a Flask blockchain demo. The standalone L1 has deterministic signed transactions, account nonces, a hard supply ceiling, a deterministic state commitment, Merkle transaction commitments, durable finalized history, >2/3 PoA finality, certified view changes, validator/protocol governance, bounded RPC/sync payloads, crash/replay tests, authenticated consensus-write RPC, and reproducible attested release artifacts.

It is nevertheless **not mainnet-ready yet**. The remaining gap is not one magic feature or a language rewrite. The main risks are concentrated in authenticated-state scalability, validator/network decentralization, mempool admission economics, key custody, fast recovery/light-client proofs, independent security review, and production operations.

“Beat Bitcoin” must not be treated as a marketing checkbox. A credible target is to beat or match measurable properties: deterministic finality latency, transaction throughput under adversarial load, node recovery time, light-client verification cost, operator diversity, fault tolerance, reproducible builds, key-compromise containment, and externally measured uptime. Bitcoin's security maturity, decentralization and battle-testing cannot be reproduced by adding features.

## Audit method and evidence

This review re-read the current consensus, state, transaction, storage, RPC/P2P, crypto, CLI and test code. It also reran the complete L1 test suite and dependency audit on the reviewed snapshot.

Current evidence at audit start:

- 37/37 L1 tests passed before new audit fixes.
- `npm audit --audit-level=low`: 0 known dependency vulnerabilities in the installed dependency graph.
- `@noble/curves` is pinned through the lockfile and secp256k1 signing uses the library's v2 prehashed-message default.
- state scaling baseline already recorded in issue #26: about 31 ms root / 5 ms clone at 10k accounts, 104 ms / 25 ms at 50k, and 145 ms / 47 ms at 100k on the measured development host.

Passing tests and a clean package audit are necessary evidence, not proof of absence of vulnerabilities.

## Severity summary

| Severity | Area | Finding | Mainnet action |
| --- | --- | --- | --- |
| Critical gate | Decentralization | A small permissioned validator set cannot claim Bitcoin-like censorship/fault resistance | define and test a credible validator admission/decentralization model before mainnet |
| High | State | `root()` sorts/serializes the entire state and block validation clones the full account map | protocol-versioned authenticated State v2 (#26) |
| High | RPC/state DoS | public balance/nonce and transaction hot paths cloned the complete state | **fix started in this audit: direct O(1) chain reads** |
| High | Mempool | future-nonce transactions receive weaker semantic admission validation; full pool has no fee-aware eviction/RBF | semantic future-tx admission, reservation accounting, fee-aware replacement/eviction |
| High | P2P | static HTTP(S) peers have no decentralized discovery, identity/diversity policy or eclipse resistance | authenticated peer identities, discovery, scoring, diversity and gossip |
| High | Keys | validator keys are plaintext local files protected mainly by file permissions | encrypted keystore + remote/HSM signer + rotation/recovery procedure |
| High | Recovery | full replay is still authoritative; snapshots are export-only because complete trusted import is not safe yet | state/schedule commitment + independently pinned checkpoint import |
| High | Assurance | no independent consensus/crypto/network audit or public adversarial testnet evidence | two independent reviews + attack testnet + bounty before mainnet |
| Medium | Block limits | validation used JS character length in two paths while production used UTF-8 bytes | **fix started in this audit: one byte-based invariant** |
| Medium | Fee market | selection is sender/nonce oriented; fee does not provide a mature congestion market | deterministic local policy, RBF/eviction, later protocol fee-market decision |
| Medium | Transport auth | one shared Bearer secret is an operational choke point | per-peer identity/mTLS/noise-style authenticated transport |
| Medium | Storage | NDJSON is durable and indexed but restart still revalidates history and lacks a native authenticated KV state store | checksumed KV state engine with atomic batches |
| Medium | Time | consensus liveness uses wall-clock deadlines and a 120-second future bound | NTP hardening, clock monitoring, adversarial time tests and documented assumptions |
| Medium | Observability | basic health/metrics exist but no production SLO/alert/forensics specification | Prometheus-grade metrics, alerts, audit events, incident runbooks |
| Medium | Wallet | no HD/hardware-wallet production standard or transaction-review UX | HD derivation, hardware signing, backup/recovery and phishing-resistant UX |
| Gate | Economics | final genesis, reward/fee policy and activity-oracle governance are not frozen | public economics/genesis review; never invent these silently in code |

## 1. Consensus and finality

### What is strong now

- Blocks require the scheduled proposer.
- Finality requires strictly greater than 2/3 of the active validators.
- Non-zero rounds require a >2/3 skip certificate for the preceding round.
- The signing journal is fsynced before attestation/skip output and prevents conflicting local actions in the same `(height, round)` across restart.
- Validator changes and protocol upgrades require current-set >2/3 approvals and delayed activation.
- Unsupported activated protocol versions fail closed.
- Tests cover 2/2 partition safety, 3/1 recovery, missed proposers, clock skew, validator rotation and protocol upgrade replay.

### Remaining risks

1. The security model is permissioned PoA. If more than one third of voting power is unavailable, liveness stops; if a Byzantine quorum controls approvals, governance/finality security is lost. This is normal for BFT-style quorum systems but must be explicit in the threat model.
2. Validator count is not validator decentralization. Mainnet needs independent operators, clouds, regions, ASNs, jurisdictions and key custody.
3. There is no formal or model-checked proof of the implemented view-change state machine. Add a small TLA+/Apalache or equivalent model and property-based traces for no-double-finality and eventual progress under assumptions.
4. Wall-clock behavior must have a documented synchrony assumption. Operators need clock drift alarms and safe NTP configuration.
5. Protocol governance and validator governance are protected cryptographically but should have emergency procedures, public activation visibility and a release compatibility matrix.

## 2. State and execution

### High-risk bottleneck

`LedgerState.root()` creates a complete sorted snapshot and hashes canonical JSON. `LedgerState.clone()` copies every account and settled epoch. Validation cost therefore grows with total historical state, not merely the keys touched in the next block.

Issue #26 is the correct architectural work item. State v2 should be an authenticated persistent structure (for example a sparse Merkle/Jellyfish-style design or an equivalently reviewed construction), with copy-on-write updates, membership/non-membership proofs, atomic disk persistence, deterministic migration, and a protocol-versioned activation.

### Newly confirmed hot-path defect

The node API previously called `chain.getState()` for `/balance`, `/nonce`, transaction nonce checks, and finalized-block mempool pruning. `getState()` deliberately returns a deep clone. A public read therefore amplified a constant-time lookup into O(number of accounts) allocation/CPU work. This is an avoidable remote resource-exhaustion surface and is being removed by exposing read-only O(1) `balance()` / `nonce()` accessors on the chain.

### State v2 requirements

- state root must bind accounts **and every consensus-relevant state machine**, including activity settlement markers and any future protocol state;
- proofs need domain separation and explicit node/leaf encodings;
- updates must be crash-atomic with the finalized block;
- old v1 roots must remain exactly verifiable before activation;
- migration must have a deterministic root and a published test vector;
- root/proof implementations need differential tests and corruption tests;
- benchmark 100k, 1M and multi-million account datasets; measure p50/p95/p99 update, root, proof and restart times.

## 3. Mempool and transaction admission

The mempool is capacity-bounded and protects duplicate txids/nonces. The chain selection path preserves nonce order and now has a transaction-byte budget, preventing oversized proposals from stalling finality.

The next attack surface is admission policy:

- future nonces are intentionally accepted within a 64-nonce window, but only next-nonce transactions receive full state application at admission;
- future governance/activity transactions therefore need explicit authorization/semantic validation before consuming pool space;
- transfers need per-sender pending-spend reservation so one confirmed balance cannot back many mutually unaffordable future transactions;
- a full pool currently rejects a new transaction rather than displacing an economically inferior one;
- same `(sender, nonce)` replacement is rejected rather than supporting a carefully bounded higher-fee RBF policy;
- block selection prioritizes sender/nonce correctness before fee and is not a mature congestion market.

Recommended sequence: semantic admission -> pending balance reservation -> per-sender quotas -> higher-fee RBF -> fee-aware tail eviction -> adversarial flood benchmarks. Do not bake an arbitrary minimum fee into consensus until economics are explicitly approved.

## 4. Block size, serialization and deterministic encoding

Canonical JSON currently gives deterministic field ordering and rejects unsafe numeric values. Consensus schemas reject unknown fields. Transaction and block hashes bind the intended signed content.

One invariant mismatch was found during this audit: block production measured `Buffer.byteLength(..., "utf8")`, while proposal/finalized validation used JavaScript string `.length`. Chain IDs are constrained to ASCII, and most consensus fields are ASCII, reducing practical exploitability, but a size limit must still have one definition. Validation is being changed to UTF-8 byte length everywhere.

Longer term, a binary, versioned canonical wire/storage codec can reduce bandwidth and parsing overhead, but changing encoding is a protocol change and must not silently rewrite v1 hashes.

## 5. Cryptography

Current positives:

- secp256k1 signatures;
- OS CSPRNG (`randomBytes`) for key generation;
- address/public-key consistency checks;
- chain ID and nonce in transaction signatures;
- block hash and chain/height binding for attestations;
- chain/height/round/previous-hash binding for skip votes;
- compact signatures are shape-checked and verification failures fail closed.

Required before mainnet:

1. independent review of every signing domain and replay boundary;
2. explicit domain tags such as `ZyronChain/tx/v1`, `.../block/v1`, `.../attest/v1` in a future protocol version to make cross-protocol reasoning simpler;
3. test vectors consumed by an independent implementation;
4. hardware/remote signer interface so consensus keys do not live in the node process;
5. key rotation, compromise and slashing/quarantine policy (if slashing is ever introduced, its economics require separate review).

Do not replace vetted primitives with custom cryptography.

## 6. P2P, peer discovery and eclipse resistance

Current networking is a bounded HTTP(S) peer protocol. It is more than a toy RPC now: chain identity is checked, responses are bounded, timeouts exist, any-peer catch-up validates candidates, and authenticated remote peer writes refuse plaintext HTTP.

It is not a decentralized P2P layer yet. Static peer lists create eclipse/censorship and operator-configuration risk. Required design:

- cryptographic node identity independent from validator voting key;
- authenticated encrypted sessions (mTLS, Noise/libp2p equivalent, or a reviewed custom protocol);
- seed/bootstrap mechanism plus decentralized discovery;
- inbound/outbound peer buckets with subnet/ASN/provider diversity;
- peer scoring, backoff, banning and misbehavior evidence;
- transaction/block gossip with deduplication and bounded queues;
- multiple independently selected sync sources;
- NAT traversal strategy and clear validator/private-RPC separation;
- fuzzing of every network decoder and state transition.

Libp2p is a reasonable candidate, not a requirement by itself. The required outcome is independently authenticated, diverse, bounded and adversarially tested connectivity.

## 7. Storage, recovery and pruning

Durability has improved substantially: finalized blocks are validated before durable append, fsynced before live-state mutation, replay is fail-closed, storage identity is pinned, history reads use byte offsets instead of retaining all finalized blocks in RAM, and crash/reopen soak tests exist.

Remaining work:

- State v2 needs atomic authenticated KV persistence.
- Checkpoint export is deterministic, but fast import is deliberately disabled because trusting a bare state root is insufficient and the state root does not currently bind every schedule. This safety decision should remain until the complete checkpoint commitment is independently anchored.
- Add pruning modes: archival, pruned full node and eventually light client.
- Add backup/restore drills and a recovery time objective.
- Add filesystem/disk-full, partial-write, bit-flip, fsync failure and abrupt-power-loss fault injection.
- Consider per-record checksums even though consensus hashes catch semantic block mutation.

## 8. Sync and light clients

Current catch-up downloads bounded batches and validates finalized blocks. This is safe but increasingly expensive for a long-lived chain.

Needed:

1. checkpoint/state sync tied to a complete authenticated state/schedule commitment;
2. independently verifiable checkpoint distribution;
3. state membership/non-membership proofs from State v2;
4. a light-client finality proof format containing validator-set transition proofs;
5. pruning without destroying the ability to prove recent state;
6. adversarial sync tests: stale peer, equivocation attempts, poisoned tails, slowloris, churn and eclipse.

## 9. RPC and denial-of-service resistance

Current protections include body/response limits, connection limits, request/header/keepalive timeouts, fixed-window client limiting, safe error serialization, optional auth for consensus writes and public health/metrics.

Mainnet work:

- eliminate O(n) public hot paths (started in this audit);
- run load tests with a million-account state and hostile concurrent reads;
- bound JSON parsing/decode CPU as well as bytes;
- put public wallet RPC and validator consensus RPC on separate listeners/security policies;
- document trusted reverse-proxy behavior instead of blindly trusting forwarded IP headers;
- use upstream DDoS controls without making the chain dependent on one provider;
- add method-specific budgets: expensive sync/proof endpoints should cost more than `/status`.

## 10. Keys, wallet and user safety

Mode `0600` is a useful baseline, not production key custody.

Validator path should support:

- encrypted keystore at rest;
- remote signer/HSM/KMS with strict signing policy;
- journal and signer coordinated so crash recovery cannot double-sign;
- offline backup and tested recovery;
- key rotation without emergency code edits;
- compromise runbook and rapid validator removal governance.

Wallet path should add deterministic HD recovery, hardware-wallet signing, checksummed/human-error-resistant address presentation, transaction simulation/review, phishing-resistant domain separation, and published offline signing formats. BIP-39/BIP-44 compatibility can help tooling but should be adopted deliberately, not copied mechanically.

## 11. Economics and governance

Protocol code already protects a 50M ZYN maximum genesis supply and does not allow activity settlement to mint. Transfer fees are burned today.

The following are **human governance/mainnet launch decisions**, not safe assumptions for an autonomous code change:

- immutable mainnet chain ID and genesis allocations;
- validator admission/decentralization model;
- validator compensation/inflation versus pure fee model;
- burn policy and fee market;
- activity pool amount and oracle governance;
- treasury, emergency authority and upgrade policy, if any.

Before mainnet, publish the exact genesis file/hash and economic specification well in advance, run independent supply-invariant tooling, and make the launch reproducible by third parties.

## 12. Release and supply-chain security

The project now has deterministic runtime packaging, checksums and GitHub/Sigstore-backed artifact attestation. Preserve this.

Still required:

- pin/monitor Actions and npm dependencies with controlled update review;
- generate an SBOM for releases;
- define supported Node runtime versions and deterministic test matrix;
- build the same release independently on multiple builders and compare artifacts;
- sign release notes/tags and publish verification instructions;
- protect the release branch/tags and use least-privilege workflow permissions;
- add secret scanning and a formal dependency-response policy.

## 13. Testing and formal assurance

The 37-test baseline exercises meaningful safety paths, but a mainnet program needs orders of magnitude more adversarial evidence.

Add:

- property-based state/transaction generation;
- differential replay across two independent implementations;
- fuzz targets for canonical decoder, transactions, blocks, proofs and network messages;
- deterministic network simulation with partitions, reordering, loss, duplication and clock drift;
- Byzantine validators: equivocation, invalid certificates, conflicting governance, withheld votes;
- long soak: millions of blocks and accounts, restart during writes, disk-full and corrupted pages;
- invariant checks: supply never increases unexpectedly, nonce monotonicity, no double finality, state-root convergence;
- performance budgets enforced in CI for state updates, signature verification, block validation and sync;
- external audit and public bug bounty before value-bearing mainnet.

## 14. Smart contracts: intentionally not the next priority

A WASM/EVM layer is not required for a blockchain to be “real”. Adding a VM before consensus/state/network maturity would multiply the attack surface: metering, determinism, reentrancy, host functions, storage accounting, compiler/toolchain and contract vulnerabilities. Finish the base monetary/consensus network, state proofs and operational hardening first. If programmability is later required, introduce it as a protocol-versioned subsystem with its own audit.

## 15. TypeScript versus Rust/Go/C++

A rewrite is not automatically a security improvement. Rewrites create new consensus bugs and invalidate existing test evidence. The measured hot spots are state cloning/root calculation and network/storage architecture; fix and benchmark those first. A second implementation in Rust or Go is valuable later as a differential verifier and diversity client. If profiling then shows Node runtime limits, migrate components with preserved wire/state test vectors rather than doing a flag-day rewrite.

## 16. Mainnet exit criteria

Do not call the network mainnet-ready until all of these are true:

- State v2 activated and benchmarked with authenticated proofs and atomic persistence.
- No O(n) public query path over total account state.
- Mempool survives economically cheap distributed spam without starving valid higher-value/control traffic.
- Diverse authenticated P2P discovery/gossip resists tested eclipse scenarios.
- Validator keys can be held outside the node process and recovered/rotated safely.
- Pruned/archive/checkpoint recovery modes are specified and disaster-tested.
- Light-client proof format covers state and validator-set transitions.
- Genesis/economics/governance are frozen and publicly reproducible.
- Two independent security reviews have no unresolved critical/high findings.
- Public adversarial testnet and bounty have run long enough to expose operational failure modes.
- Release artifacts are reproducible, checksummed, attested and independently verifiable.
- Multi-region operators demonstrate SLOs, alerting, backup/restore and incident-response drills.
- Independent implementation/differential replay agrees on long randomized histories.

## 17. Prioritized execution plan

### P0 — now

1. Remove full-state clones from public/query/mempool hot paths. **In progress with this audit.**
2. Normalize every block-size rule to UTF-8 bytes. **In progress with this audit.**
3. Harden future-nonce mempool semantic admission and pending-balance reservation. **Implemented after the audit; pending CI/merge verification.**
4. Implement fee-aware RBF/eviction without turning fee policy into an accidental consensus rule.
5. Execute State v2 design in issue #26 with migration/proof/crash benchmarks.

### P1 — before adversarial public testnet

6. Authenticated peer identity + discovery + diversity/scoring/gossip.
7. Remote/HSM validator signer and key rotation.
8. State/checkpoint sync and pruning.
9. Property/fuzz/model-based consensus testing.
10. Production metrics, SLOs and incident/fault-injection runbooks.

### P2 — before value-bearing mainnet

11. Light-client finality/state proofs.
12. Independent client/differential verifier.
13. Independent audits + public bounty.
14. Freeze and publish genesis/economics/governance.
15. Multi-operator/multi-provider launch rehearsal and disaster recovery.

### P3 — after base-chain maturity

16. Evaluate WASM programmability only if the product requires it.
17. Evaluate alternative implementation languages from profiling and client-diversity needs, not fashion.

## Final assessment

The project has crossed an important line: core safety properties are now explicit and regression-tested rather than implied by a web application. The remaining work is harder because it is the work that separates a functioning chain from a credible public monetary network: authenticated state at scale, decentralized networking/operators, safe key custody, economic spam resistance, recovery/light clients, independent verification and sustained adversarial operations.

The correct engineering posture is therefore: **preserve existing consensus invariants, remove measurable bottlenecks/attack surfaces one at a time, attach a regression test to each fix, and never trade verifiability for feature count.**
