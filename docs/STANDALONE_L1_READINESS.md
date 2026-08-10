# ZyronChain standalone L1 — A–Z readiness review

This document is the release/activation gate for the standalone TypeScript L1. **Governance authorization has been granted for both the public-testnet and mainnet network classes.** **Public testnet launch is currently blocked** at the activation gate; value-bearing mainnet activation is also blocked. Green CI, a release artifact or governance authorization does not waive the evidence requirements below. The historical Python/Flask `zyron-testnet-1` remains a compatibility/testnet system and is not silently rebranded as the canonical chain.

The machine-readable authority is `docs/l1-launch-authorization.json`: `publicTestnetAuthorized=true` and `mainnetAuthorized=true`, while `publicTestnetActivationAllowed=false` and `mainnetActivationAllowed=false`.

| ID | Area | Status | Evidence / remaining work |
|---|---|---|---|
| A | Addresses & accounts | Implemented | secp256k1-derived `ZYN` addresses, exact atom balances, sequential nonces |
| B | Blocks | Implemented | versioned signed headers, previous hash, Merkle tx root, state root, size/count caps |
| C | Consensus | Implemented with audit gate | >2/3 PoA attestations plus deadline-gated >2/3 skip certificates; missed rounds progress sequentially and cannot be jumped without predecessor quorum evidence; executable bounded certificate modeling exhausts practical quorum/fault sets and includes an unsafe-quorum mutation counterexample; independent formal/security review remains |
| D | Data durability | Implemented | finalized blocks are validated before durable fsync and only then applied to live state; ambiguous append/fsync outcomes fail-stop until restart; OS-backed SQLite writer leases serialize node/snapshot/prune writers; append-only storage, pinned metadata, replay validation, corrupt-record fail-stop, crash/reopen soak and SIGKILL boundary injection are exercised |
| E | Economics | Implemented with mainnet gate | hard 50M ZYN cap, 1e8 atoms/ZYN, finite activity pool and explicit fee burn are enforced; immutable mainnet allocation/reward/fee policy is not frozen |
| F | Finality | Implemented | unique configured validator signatures; quorum = `floor(2N/3)+1` |
| G | Genesis | Implemented with mainnet gate | deterministic chain identity/genesis hash; immutable mainnet chain ID and allocation are intentionally not invented by autonomous code changes |
| H | Hashing | Implemented | SHA-256 canonical payloads and deterministic Merkle/state commitments |
| I | Input validation | Implemented | exact wire schemas, unknown-field rejection, integer bounds, lowercase-hex validation, bounded bodies |
| J | Journaling | Implemented | persistent `(height, round)` journal makes block attestation and round-skip mutually exclusive across restart; uncertain writes fail-stop and one data directory has one live validator writer |
| K | Keys | Implemented with production-custody gate | local encrypted keystores and a pinned provider-neutral remote signer boundary exist; returned signatures are reverified and anti-equivocation state is fsynced before signing. Required CI rehearses quorum-authorized delayed validator-key replacement, retired-key rejection, replacement proposal/finality and restart persistence. Production HSM/audited signer custody and cross-host recovery remain external |
| L | Ledger state | Implemented with target-hardware gate | authenticated State-v2 uses SQLite-indexed immutable nodes, semantic-key preimages, bounded resolver cache, file-backed traversal metadata, portable state sync, checkpoint recovery and explicit-pruning GC. Required CI now archives a **100,000-account** restart/GC/root/cache regression run and verifies root stability, the resolver-cache bound and historical-node collection. This GitHub-hosted measurement does **not** close release/target-hardware capacity evidence |
| M | Mempool | Implemented | duplicate tx/nonce protection, bounded capacity, nonce-aware selection, future-nonce window, pending-spend controls, stale-conflict pruning and a 1.5 MB transaction payload budget |
| N | Networking | Implemented with external-network gate | Noise-authenticated native P2P binds PeerId+node key+chain/genesis; pinned bootstrap, signed discovery, topology/failure-domain diversity, scoring/backoff, gossip, state/checkpoint/suffix sync, response preflight, aggregate byte budgets, telemetry and stream/rate/work caps are implemented. Required CI also runs separate compiled processes over real loopback TCP/Noise/yamux with catch-up and SIGKILL/restart. Sustained independent-operator Internet routing evidence remains |
| O | Operations | Implemented with external rehearsal gate | operations runbook, metrics/SLO alerts, backup/restore, incident, eclipse/key-compromise and upgrade procedures exist. Required CI executes checkpoint recovery, validator-key replacement and same-data supervised recovery. A clean external-directory rehearsal installs **only the packaged release tarball**, reaches organic two-validator finality and recovers a restarted validator without source-tree runtime files. Real independent operator, multi-region and production custody drills remain |
| P | Proof of Activity | Implemented with governance gate | oracle-signed receipt-root batches spend only a prefunded pool; production receipt service/oracle governance must be independent or the feature must remain disabled/unfunded |
| Q | Quorum safety | Implemented | configured validator uniqueness, signature checks, >2/3 requirement and anti-double-sign journal |
| R | RPC | Implemented with deployment gate | RPC has body/response/inflight/connection/time/header/request-per-socket budgets, API-version negotiation, authentication boundaries, readiness/liveness separation and pressure metrics. Non-loopback consensus RPC requires authentication plus trusted HTTPS proxy semantics. The read-only Render rehearsal gateway additionally has request-target validation, loopback redaction, coalesced status aggregation, active-request admission, socket/header deadlines and burst/slow-header red-team coverage. Production perimeter/certificate evidence remains |
| S | Supply safety | Implemented | genesis total capped at 50M ZYN; settlements cannot mint; transfers/fees cannot increase state supply |
| T | Transactions | Implemented | canonical signed transfers/activity settlements, txid binding, chain ID, nonce/balance checks and protocol-v3 signing domains |
| U | Upgrades | Implemented with operational gate | protocol v3 activates domain-separated signing over State-v2; rollback schedules and validator-set rotation require >2/3 active-validator approval with delayed activation. Required CI builds a fixed historical pre-v3 binary, proves exact supported-history convergence, fail-stop at v3 activation, rolling replacement, continuation and authorized rollback |
| V | Validation | Implemented | proposal/finalized-block re-execution reproduces committed transaction and state roots |
| W | Wallet/operator UX | Implemented with production UX gate | keygen and transfer CLI support local development keys/encrypted keystores; hardware-wallet/mobile wallet integration remains |
| X | eXternal audit | Prepared with independent-audit gate | the commit-bound audit pack now inventories/digests consensus/network/crypto/storage/key/release modules **and** release-artifact operation, independent-operator challenge controls, 100k State-v2 scale evidence, Render hosting policy, hosted duration-soak verifier, succession policy and launch authorization. Independent cryptography/consensus/network review, remediation and independent retest remain mandatory; project-produced audit artifacts are not an independent audit |
| Y | Yield/rewards | Mainnet gate | no validator inflation is invented. Any validator compensation/inflation/fee policy must be explicitly frozen with mainnet launch specifications |
| Z | Zero-downtime resilience | Partial external gate | view-change, proposer failure, partition recovery, clock-skew rejection, persistence fail-stop, signal drain/restart, mixed-version activation/rollback, checkpoint DR, 600-height composed fault soak, multi-process native P2P SIGKILL/catch-up and same-data clock-supervisor recovery are exercised. Sustained Internet soak, faulted multi-operator rolling upgrades and multi-region DR remain |

## Governance authorization versus activation

`docs/l1-launch-authorization.json` is the authoritative governance record for network classes:

- `publicTestnetAuthorized: true`
- `mainnetAuthorized: true`
- `publicTestnetActivationAllowed: false`
- `mainnetActivationAllowed: false`
- `authorizationDoesNotWaiveReadinessGates: true`

Authorization means the project is allowed to prepare and eventually activate those network classes. It is **not** evidence that the external operational/security gates have already happened.

## Internal private/adversarial preflight

`l1-private-testnet-preflight.json` and `verify-private-testnet-preflight.mjs` define a profile-specific fail-closed engineering preflight. That profile intentionally keeps its own `publicTestnetAuthorized:false` and `mainnetAuthorized:false` because a private rehearsal profile must never self-promote into a public network. The global launch-authorization policy is a separate higher-level governance record.

A green internal preflight proves canonical/legacy separation, Node 22/24 coverage, independent light-client verification, adversarial/recovery/upgrade/key-rotation evidence, operations documentation, security/succession controls, hosting-policy controls and audit handoff are internally coherent. The honest current implementation label remains **standalone multi-validator devnet/testnet L1** with governance-authorized but not activation-approved public-testnet/mainnet classes.

## Founder/operator handoff evidence

The repository now contains:

- public `SECURITY.md` and maintainer/security succession policy;
- a minimum-two-independent-custodian requirement;
- clean release-artifact-only operator rehearsal;
- an independent-operator challenge and evidence verifier;
- synthetic positive/negative challenge vectors that deliberately keep `independenceProven=false`;
- commit-bound audit/release/checksum/SBOM evidence.

These controls make the handoff reproducible, but they do not manufacture independent humans, credentials, providers or failure domains. Actual independent custody/operator evidence remains an activation gate.

## Hosting and sustained-soak evidence

The connected Render **Free** profile is machine-classified as smoke-only/bounded-adversarial evidence. Platform inactivity shutdowns mean it cannot provide continuous-uptime evidence, and artificial self-ping/keepalive traffic is explicitly forbidden.

A hosted duration-soak policy/verifier is now prepared for reviewed always-on compute. The initial public-testnet engineering threshold requires at least 6 hours, monotonic finalized progress, bounded finality gap, >=3/4 validator readiness, <=80% memory utilization, zero clock/persistence faults and accounted same-data restarts. Required CI exercises this verifier with synthetic positive/negative vectors, but synthetic output explicitly keeps real sustained-uptime/public-testnet activation evidence false. Issue #249 remains open until real always-on infrastructure and real duration evidence exist.

## Public-testnet activation gates

Public-testnet governance authorization exists, but activation remains blocked until all of the following are closed with evidence:

1. **Independent operators:** non-founder operators deploy from published release artifacts without private assistance and pass the public independent-operator challenge.
2. **Independent failure domains:** bootstrap/archive/monitoring/checkpoint infrastructure spans genuinely independent operators/providers/networks rather than labels invented to satisfy a selector.
3. **Independent security review:** cryptography/consensus/network review—including skip-certificate view change—and independent retest have no unresolved critical/high findings.
4. **Sustained adversarial Internet evidence:** reviewed always-on infrastructure produces accepted duration-soak evidence and broader independent-operator Internet tests cover latency/loss/partition, hostile RPC/P2P pressure and eclipse/Sybil routing.
5. **Production validator custody:** HSM or independently audited remote signer custody, token/credential procedures and cross-host rotation/recovery are exercised.
6. **Protected release/review policy:** protected branch/review/release controls are active in repository settings and no unique founder credential is required.
7. **Target deployment capacity:** State-v2 scale/recovery limits are measured on intended release hardware; the 100k GitHub CI baseline is regression evidence only.
8. **Independent succession evidence:** repository/release/security/domain/checkpoint capability is held/rehearsed by the required independent custodians.

Until these are independently closed, `publicTestnetActivationAllowed` must remain `false`.

## Mainnet stop-ship gates

Value-bearing mainnet activation requires every public-testnet activation gate plus:

1. immutable mainnet chain ID and published genesis hash;
2. immutable genesis allocation/supply review;
3. explicit validator reward/inflation/fee policy;
4. production activity-oracle governance or a deliberate disabled/unfunded policy;
5. public validator admission/removal governance;
6. target-hardware State-v2 capacity/recovery evidence;
7. sustained adversarial public-testnet evidence and independent audit/retest;
8. multi-region restore, upgrade, rollback and incident-response evidence;
9. independent maintainer/security/release/domain custody succession;
10. protected release/tag/branch review policy and independently reproducible artifacts.

No autonomous change should invent these irreversible launch choices merely to flip `mainnetActivationAllowed` to `true`.

Until every stop-ship gate is closed with evidence, the project must not describe itself as “100% certified mainnet”, permissionless, Bitcoin-equivalent or founder-independent.
