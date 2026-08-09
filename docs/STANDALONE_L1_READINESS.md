# ZyronChain standalone L1 — A–Z readiness review

This document is the release gate for the standalone TypeScript L1. **Public testnet launch is currently blocked**; green CI or a release artifact is not launch authorization. `Implemented` means exercised by code/tests in this branch. `Gate` means it must be completed before a public mainnet claim. The historical Python/Flask `zyron-testnet-1` remains a compatibility/testnet system and is not silently rebranded as mainnet.

| ID | Area | Status | Evidence / remaining work |
|---|---|---|---|
| A | Addresses & accounts | Implemented | secp256k1-derived `ZYN` addresses, exact atom balances, sequential nonces |
| B | Blocks | Implemented | versioned signed headers, previous hash, Merkle tx root, state root, size/count caps |
| C | Consensus | Implemented with audit gate | >2/3 PoA attestations plus deadline-gated >2/3 skip certificates; missed rounds progress sequentially and cannot be jumped without predecessor quorum evidence; an executable bounded model exhausts quorum/fault sets for 1–10 validators and includes an unsafe-quorum mutation counterexample; independent formal/security review remains |
| D | Data durability | Implemented | finalized blocks are validated before durable fsync and only then applied to live state; ambiguous append/fsync outcomes fail-stop until restart; node/snapshot/prune writers are serialized by an OS-backed SQLite lease; append-only storage, pinned metadata, full replay validation, corrupt-record fail-stop and repeated 100-block crash/reopen replay soak |
| E | Economics | Implemented with gate | hard 50M ZYN cap, 1e8 atoms/ZYN, finite activity pool, explicit fee burn; final public allocation requires immutable mainnet genesis review |
| F | Finality | Implemented | unique configured validator signatures; quorum = `floor(2N/3)+1` |
| G | Genesis | Implemented with gate | deterministic chain identity/genesis hash; public mainnet chain ID and allocation are intentionally not invented here |
| H | Hashing | Implemented | SHA-256 canonical payloads and deterministic Merkle/state commitments |
| I | Input validation | Implemented | exact wire schemas, unknown-field rejection, integer bounds, lowercase-hex validation, bounded bodies |
| J | Journaling | Implemented | persistent `(height, round)` journal makes block attestation and round-skip mutually exclusive across restart; write/fsync/close uncertainty fail-stops the live journal and a separate SQLite lease rejects a second validator writer for the same data directory |
| K | Keys | Implemented with gate | local keys support authenticated AES-256-GCM keystores with scrypt-derived keys, bounded password files and 0600 permissions; validator proposal/attestation/skip signing also supports a pinned provider-neutral remote-signer boundary with signature re-verification and fsynced anti-equivocation reservation before signing; local concurrent-validator reuse of one data directory is rejected; production HSM policy, custody audit and cross-host rotation/recovery drill remain |
| L | Ledger state | Implemented with scale gate | authenticated State v2 uses SQLite-indexed immutable nodes and semantic-key preimages, a bounded resolver cache, file-backed startup traversal metadata, externally anchored portable state sync, checkpoint recovery and explicit-pruning GC; current state is no longer fully hydrated in RAM. Repeat large-cardinality restart/GC measurements on release hardware before mainnet capacity freeze |
| M | Mempool | Implemented | duplicate tx/nonce protection, bounded capacity, single-pass nonce-aware chain selection, future nonce window, stale-conflict pruning and a 1.5 MB transaction payload budget that prevents oversized proposals from stalling finality |
| N | Networking | Implemented with gate | Noise-authenticated native P2P binds PeerId+node key+chain/genesis; pinned bootstrap, bounded signed discovery, topology/failure-domain diversity, scoring/backoff, gossip, state/checkpoint/suffix sync, stream/rate/work caps and eclipse/Sybil regressions are implemented; sustained independent-operator public-network evidence remains |
| O | Operations | Implemented with rehearsal gate | structured persistence/finality/recovery metrics and `L1_OPERATIONS_RUNBOOK.md` define SLO alerts, backup/restore, incident, eclipse/key-compromise and upgrade procedures; multi-region independent operators must still execute and archive repeated restore/incident drills |
| P | Proof of Activity | Implemented with gate | oracle-signed receipt-root batches spend only a pre-funded pool; independent receipt service/oracle governance must be productionized |
| Q | Quorum safety | Implemented | configured validator uniqueness, signature checks, >2/3 requirement, anti-double-sign journal |
| R | RPC | Implemented with gate | bounded RPC includes explicit API-version advertisement/negotiation, unsupported-version rejection, per-client request limiting, connection/time limits, health/metrics and optional constant-time Bearer authentication for consensus writes; reverse-proxy TLS and deployment-time auth enforcement remain |
| S | Supply safety | Implemented | genesis total capped at 50M ZYN; settlements cannot mint; transfers/fees cannot increase state supply |
| T | Transactions | Implemented | canonical signed transfers/activity settlements, txid binding, chain ID, nonce/balance checks |
| U | Upgrades | Implemented with operational gate | protocol v3 activates domain-separated signing over State v2; rollback schedules and validator-set rotation require >2/3 active-validator approval with 100-block delayed activation; State-v2-to-v1 rollback reconstructs authenticated legacy state across restart, schedules replay after restart, and unsupported binaries fail-stop at activation |
| V | Validation | Implemented | proposal and finalized block re-execution produces deterministic state roots |
| W | Wallet/operator UX | Implemented with gate | keygen and signed transfer CLI support legacy 0600 development keys and password-file encrypted local keystores; hardware-wallet/mobile wallet integration remains |
| X | eXternal audit | Gate | independent cryptography/consensus/network review and remediation are mandatory before public mainnet |
| Y | Yield/rewards | Gate | no invented validator inflation. Any validator/reward economics must be explicitly specified before immutable mainnet genesis |
| Z | Zero-downtime resilience | Partial gate | certified view-change, 4-validator/120-block repeated-proposer-failure convergence, 2/2 partition safety with 3/1 recovery/catch-up, clock-skew rejection and corrupt-store fail-stop regressions are implemented; sustained real-network soak, rolling-upgrade tests and disaster-recovery drill remain |

## Mainnet stop-ship gates

The following are not paperwork; they are technical or operational safety requirements:

1. Run a sustained public-testnet protocol upgrade and rollback drill, including mixed old/new binaries, pre-activation readiness checks and operator rollback evidence.
2. Run sustained adversarial multi-node tests covering partitions, crash/restart, disk faults, replay, equivocation, malformed RPC traffic, clock skew, sequential view changes and peer eclipse attempts.
3. Complete an independent security/cryptography/consensus audit—including the skip-certificate view-change—and close all critical/high findings.
4. Freeze an immutable mainnet chain ID, genesis allocation, activity-oracle governance and reward/fee policy; publish its hash before launch.
5. Add production key custody (HSM or audited remote signer), authenticated network perimeter, rate limits, metrics/alerts, backups and tested restore/incident procedures.
6. Enforce protected-branch/review release policy. Deterministic L1 tarballs, SHA-256
   checksums, a checksummed SPDX release SBOM, locked-dependency CI and
   GitHub/Sigstore build-provenance attestations are produced by the tag release
   workflow. CI Actions are immutable-SHA pinned and Dependabot monitors Actions,
   npm and the independent verifier dependency without auto-merge; repository
   branch protection remains an operator/repository-settings gate.

Until every stop-ship gate above is closed with evidence, the honest label is **standalone multi-validator devnet/testnet L1**, not “100% certified mainnet.”
