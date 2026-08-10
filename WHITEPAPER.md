# ZyronChain technical paper

Version: governance-authorized, activation-gated pre-public-testnet draft  
Canonical implementation: standalone TypeScript L1 in `l1/`

## 1. Status and purpose

ZyronChain is an account-based Layer-1 blockchain designed around deterministic execution, authenticated state, explicit protocol upgrades and fast quorum finality.

This paper describes the canonical TypeScript implementation. The historical Python/Flask Proof-of-Work testnet is retained only for compatibility and is not the target consensus network.

Public-testnet and mainnet **governance authorization has been granted** by the repository owner and is recorded in `docs/l1-launch-authorization.json`. Authorization is not activation: public-testnet activation and value-bearing mainnet activation remain evidence-gated. This paper does not waive those gates. Genesis allocation, validator admission, activity-oracle governance and validator economics remain explicit launch decisions.

## 2. Design goals

ZyronChain prioritizes:

- deterministic validation and replay;
- exact integer monetary accounting;
- explicit chain/genesis/protocol identity;
- finality with independently verifiable quorum evidence;
- fail-closed protocol upgrades and rollback;
- authenticated state proofs and bounded recovery;
- validator anti-equivocation across crash/restart;
- authenticated, resource-bounded peer networking;
- reproducible, checksummed and attested releases;
- removal of hidden administrator and minting authority.

The design does not claim Bitcoin-equivalent decentralization, security maturity or permissionless participation.

## 3. Units and supply

One ZYN equals 100,000,000 integer atoms. Consensus does not use floating-point balances.

Genesis allocations are capped at 50,000,000 ZYN. Transfers debit `amount + fee`, credit only `amount`, and currently burn the fee. Proof-of-Activity settlement cannot mint; it can distribute only atoms already assigned to its activity pool.

The final mainnet allocation, validator compensation and fee/reward policy are not yet frozen.

## 4. Accounts and transactions

Accounts use addresses derived from secp256k1 public keys. Transactions bind:

- chain ID;
- sender and sender-derived public key;
- sequential sender nonce;
- exact integer amounts;
- transaction kind and fields;
- protocol-specific transaction format;
- canonical signature and transaction ID.

Protocol v3 uses fixed signing domains so a signature authorized for one transaction, governance action or consensus intent cannot be replayed as another.

The mempool bounds capacity, serialized bytes, sender nonce windows and conflicts. Admission reserves pending sender balance and block selection respects nonce order and the transaction-byte budget. Local fee and replacement policy must not silently become a consensus rule.

## 5. Blocks and execution

Every non-genesis block commits to:

- chain/protocol version;
- height, round and previous block hash;
- proposer identity and signature;
- canonical transaction Merkle root;
- authenticated state root;
- timestamp;
- round-skip certificate when required;
- unique validator finality attestations.

Nodes strictly validate wire schemas and reject unknown fields, invalid integer ranges, oversized payloads, wrong proposer schedules, invalid transactions, inconsistent roots and insufficient finality.

A finalized block is re-executed before durable acceptance.

## 6. Consensus and finality

The current network model is permissioned validator quorum.

At height `h`, the scheduled proposer for round zero creates a block. Finality requires `floor(2N/3)+1` unique attestations from the active validator set.

If the proposer misses its deadline, validators may sign a round-skip vote. A later round requires a valid >2/3 certificate for the immediately preceding round. Rounds cannot be jumped.

A persistent signing journal reserves validator action before local or remote signing and prevents attestation/skip conflicts for the same `(height, round)` across restart and uncertain signer outcomes.

Safety depends on the quorum fault assumption. Liveness stops if insufficient validators can communicate. The system is not permissionless and must not be marketed as such.

## 7. Authenticated State-v2

Protocol versions 2 and 3 use State-v2, an authenticated sparse-Merkle state backed by immutable content-addressed nodes and a SQLite index.

State-v2 commits to consensus-relevant account and governance state, including balances, nonces, activity settlement markers, validator schedules and protocol schedules. Semantic-key preimages permit exact reconstruction of the portable state view.

Properties include:

- copy-on-write updates;
- membership and non-membership proofs;
- bounded resolver caches;
- durable semantic-key indexes;
- checkpoint export/import with external anchors;
- corruption quarantine and deterministic reconstruction;
- explicit authenticated pruning;
- deterministic State-v2-to-legacy reconstruction at authorized rollback boundaries.

Required CI now archives a 100,000-account restart/GC/root/cache regression baseline. That is useful regression evidence, but target/release-hardware scale and recovery measurements are still required before public-testnet activation and mainnet capacity freeze.

## 8. Validator and protocol governance

Validator-set updates and protocol changes are transactions authorized by a strictly-greater-than-2/3 quorum of the current active validators.

They require delayed activation of at least 100 blocks. Finalized history reconstructs identical schedules after restart.

Protocol v3 activates domain-separated consensus, transaction and governance signatures while retaining State-v2. Unsupported active versions fail closed. Authorized rollback schedules are executable and tested across durable restart.

This cryptographic mechanism does not decide who should be a validator. Admission, independence requirements and emergency governance must be specified publicly before mainnet activation.

## 9. Proof of Activity

Activity settlement uses oracle-signed receipt-root batches. A settlement can spend only the prefunded activity pool and cannot increase total supply.

Before public-testnet activation, either:

- the feature remains disabled/unfunded; or
- independent receipt services and oracle governance are deployed and audited.

A founder-controlled oracle is incompatible with founder-independent operation.

## 10. Networking

The preferred node data plane uses libp2p TCP, Noise and yamux.

Native sessions bind:

- Noise-authenticated PeerId;
- persistent node public key;
- chain ID;
- genesis hash.

The implementation includes bounded connection upgrades, streams, request rates, response sizes, fanout, deduplication, inflight work and dial concurrency. Configured bootstrap peers pin PeerIds. Discovery candidates must pass identity and network checks before admission.

Peer scoring, backoff, topology buckets and operator-supplied failure domains reduce eclipse concentration. They do not create decentralization by themselves; independent operators and infrastructure are required.

## 11. RPC boundary

Wallet/public HTTP RPC and validator consensus networking are separate security surfaces.

RPC responses advertise an explicit API version. Unsupported requested versions receive HTTP 426. Public RPC is resource bounded and intended to sit behind a separately controlled TLS/rate-limiting perimeter.

Consensus writes require authenticated peer credentials when exposed beyond loopback. Bearer tokens are a legacy/private deployment option; signed node identity or native P2P is preferred.

## 12. Checkpoints, pruning and light clients

Checkpoint installation never trusts a serving peer to choose the anchor. Operators supply an independently authenticated finalized tip hash and snapshot digest.

Installation validates chain/genesis identity, finality, validator/protocol schedules and state roots before atomically publishing a new data directory.

Light clients begin from an independently trusted anchor and verify:

- hash continuity;
- proposer and view-change evidence;
- finality quorum;
- protocol version;
- State-v2 membership/non-membership;
- authenticated validator-set transitions.

A Python verifier consumes public interoperability vectors as an independent implementation boundary.

## 13. Keys

Production validators should use a pinned remote signer or HSM boundary. The node verifies every returned signature against the exact public key, payload, intent and protocol domain.

The anti-equivocation journal is persisted before a remote signing request. A signer outage may sacrifice liveness for one action but must not permit a conflicting signature after restart.

Local operator keys may use scrypt-derived AES-256-GCM keystores with authenticated public-key/address metadata and bounded password files. This is not a substitute for production HSM custody.

## 14. Persistence and recovery

Finalized records are validated, durably appended and only then applied to live state. Ambiguous persistence outcomes fail stop until restart.

A SQLite writer lease prevents concurrent node, snapshot and prune writers from mutating one data directory. Replay, checkpoint restoration, State-v2 rebuild and protocol rollback are regression tested.

Operators must retain independent archive nodes and rehearse restore, suffix catch-up and key-compromise procedures.

## 15. Releases

CI runs TypeScript checks and tests on Node.js 22 and 24, audits runtime dependencies and runs the independent Python verifier.

Tags matching `l1-v*` produce:

- deterministic npm tarball;
- SPDX runtime SBOM;
- SHA-256 manifest;
- GitHub artifact attestations.

A clean external-directory rehearsal installs only the packaged tarball, proves organic two-validator finality and proves restart/recovery without source-tree runtime files. Release provenance and artifact rehearsals prove what was built and that it can be operated; they do not prove consensus correctness or independently close activation gates.

## 16. Founder independence

The network is not founder-independent until:

- founders do not control a validator quorum or unique recovery key;
- validator, bootstrap, archive, explorer and checkpoint services span independent operators;
- source/release/security governance has succession;
- activity-oracle control is distributed or disabled;
- third parties can build, restore, rotate, upgrade and release without private assistance;
- genesis and economics are immutable and publicly reproducible.

The repository includes a public independent-operator challenge and maintainer/security succession policy. Their CI verifies policy/evidence shape, but deliberately does not claim that real independent custody or operator independence has already been achieved.

Founder withdrawal must preserve public history and audit evidence.

## 17. Launch gates

Governance authorization for both the public-testnet and mainnet network classes is recorded in `docs/l1-launch-authorization.json`. The same policy currently keeps both activation flags false.

Public-testnet activation still requires independent operator deployment, multi-domain bootstrap/archive infrastructure, independent security review/retest, sustained adversarial Internet evidence, production signer custody and protected release/review policy. The connected Render Free profile is smoke-only; a separate hosted-duration evidence verifier is prepared for reviewed always-on infrastructure, but synthetic CI cannot satisfy the real uptime gate.

A value-bearing mainnet additionally requires all public-testnet activation requirements plus immutable chain ID/genesis allocation/economics/oracle/validator-governance specifications, target-hardware State-v2 evidence, multi-region recovery/incident evidence and independent maintainer/security custody succession.

The authoritative checklist is [`docs/STANDALONE_L1_READINESS.md`](docs/STANDALONE_L1_READINESS.md); launch authorization is [`docs/L1_LAUNCH_AUTHORIZATION.md`](docs/L1_LAUNCH_AUTHORIZATION.md); the threat assumptions are [`docs/L1_THREAT_MODEL.md`](docs/L1_THREAT_MODEL.md).
