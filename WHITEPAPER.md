# ZyronChain technical paper

Version: governance-authorized, activation-gated pre-public-testnet draft  
Canonical implementation: standalone TypeScript L1 in `l1/`

## 1. Status and purpose

ZyronChain is an account-based Layer-1 blockchain designed around deterministic execution, authenticated state, explicit protocol upgrades, permissionless proof-of-work issuance and fast quorum finality.

This paper describes the canonical TypeScript implementation. The historical Python/Flask Proof-of-Work testnet is retained only for compatibility and is not the target consensus network.

Public-testnet and mainnet **governance authorization has been granted** by the repository owner and is recorded in `docs/l1-launch-authorization.json`. Authorization is not activation: public-testnet activation and value-bearing mainnet activation remain evidence-gated. This paper does not waive those gates. Final public genesis parameters, validator admission, mining calibration, activity-oracle governance and validator economics remain explicit launch decisions.

## 2. Design goals

ZyronChain prioritizes:

- deterministic validation and replay;
- exact integer monetary accounting;
- explicit chain/genesis/protocol identity;
- finality with independently verifiable quorum evidence;
- permissionless, deterministic ZYN issuance without a privileged mint key;
- fail-closed protocol upgrades and rollback;
- authenticated state proofs and bounded recovery;
- validator anti-equivocation across crash/restart;
- authenticated, resource-bounded peer networking;
- reproducible, checksummed and attested releases;
- removal of hidden administrator and minting authority.

The design does not claim Bitcoin-equivalent decentralization or security maturity. Permissionless mining participation must not be confused with permissionless block-finality participation: the current finality layer still uses an explicitly governed validator set.

## 3. Units, supply and issuance

One ZYN equals 100,000,000 integer atoms. Consensus does not use floating-point balances.

The immutable **maximum historical issuance is 50,000,000 ZYN**. Genesis allocations consume that cap atom-for-atom; the remaining issuance budget is available only through protocol-v5 mining. A zero-premine public profile can initialize required addresses with zero-value genesis allocations, creating no circulating ZYN at genesis.

Protocol v5 introduces permissionless proof-of-work mining claims:

- initial reward: **6.25 ZYN** per successful finalized claim;
- reward halving: every **4,000,000 successful finalized claims**;
- maximum: one mining claim per finalized block;
- proof target: an initial fixed 20-bit SHA-256 threshold;
- challenge binding: chain ID, miner nonce/address/public key, next height, previous finalized hash, protocol-derived reward and work nonce.

The chain stores a consensus-owned global mining-claim counter at the reserved zero-balance account `ZYN0000000000000000000000000000000000000000`. The account cannot be funded, spent, mined from, used as the activity pool or receive a genesis allocation. Its nonce tracks finalized mining claims and makes historical issuance independent of current spendable balances.

Transfers debit `amount + fee`, credit only `amount`, and currently burn the fee. Burned ZYN remains permanently burned: fee destruction does not reopen mining headroom. Proof-of-Activity settlement cannot mint; it can distribute only atoms already assigned to its activity pool.

The mainnet launch profile still must freeze the exact genesis, mining calibration/difficulty policy, validator compensation and any future fee/reward policy before value-bearing activation.

## 4. Accounts and transactions

Accounts use addresses derived from secp256k1 public keys. Transactions bind:

- chain ID;
- sender and sender-derived public key;
- sequential sender nonce;
- exact integer amounts;
- transaction kind and fields;
- protocol-specific transaction format;
- canonical signature and transaction ID.

Protocol v3 and later domain-separated transaction formats use fixed signing domains so a signature authorized for one transaction, governance action or consensus intent cannot be replayed as another. Protocol v5 adds the `mining_claim` transaction kind, which is version-2 signed and carries a tip-bound proof-of-work solution plus the deterministic protocol reward.

The mempool bounds capacity, serialized bytes, sender nonce windows and conflicts. Admission reserves pending sender balance where applicable and block selection respects nonce order and the transaction-byte budget. Mining claims are revalidated against the current finalized tip and issuance counter; stale claims fail closed. Local fee and replacement policy must not silently become a consensus rule.

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

A finalized block is re-executed before durable acceptance. Under protocol v5, consensus additionally permits at most one valid mining claim in a block and independently recomputes its proof, target, tip binding, reward and historical issuance budget.

## 6. Consensus and finality

The current **block-finality model is permissioned validator quorum**.

At height `h`, the scheduled proposer for round zero creates a block. Finality requires `floor(2N/3)+1` unique attestations from the active validator set.

If the proposer misses its deadline, validators may sign a round-skip vote. A later round requires a valid >2/3 certificate for the immediately preceding round. Rounds cannot be jumped.

A persistent signing journal reserves validator action before local or remote signing and prevents attestation/skip conflicts for the same `(height, round)` across restart and uncertain signer outcomes.

Safety depends on the quorum fault assumption. Liveness stops if insufficient validators can communicate. Validator participation and canonical-chain selection are therefore not currently permissionless. Protocol-v5 mining is permissionless only in the narrower, explicit sense that any valid key holder may compete for issuance without validator membership or a privileged mint credential.

Mining hash power does **not** choose the canonical chain or scheduled proposer. Validators may censor mining claims they have received, just as they can censor ordinary transactions; this is a material threat-model limitation, not something proof-of-work issuance alone removes.

## 7. Authenticated State-v2

Protocol versions 2, 3 and 5 use State-v2, an authenticated sparse-Merkle state backed by immutable content-addressed nodes and a SQLite index. Protocol v4 remains intentionally unsupported/fail-stop.

State-v2 commits to consensus-relevant account and governance state, including balances, nonces, activity settlement markers, validator schedules, protocol schedules, miner balances and the global mining-claim counter. Semantic-key preimages permit exact reconstruction of the portable state view.

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

Protocol v3 activates domain-separated consensus, transaction and governance signatures while retaining State-v2. Protocol v5 retains those protections and adds permissionless proof-of-work issuance. Protocol v4 remains deliberately unsupported so an accidental v4 activation still fails closed. Other unsupported active versions fail closed. Authorized rollback schedules are executable and tested across durable restart.

This cryptographic mechanism does not decide who should be a validator. Admission, independence requirements and emergency governance must be specified publicly before mainnet activation.

## 9. Permissionless proof-of-work issuance

Mining is an **issuance mechanism**, not a replacement consensus chain-selection algorithm.

A miner constructs a challenge from the current finalized tip and its own account identity, searches a 64-bit hexadecimal work-nonce space, and submits a signed `mining_claim` only when the SHA-256 work hash is below the protocol target. The miner's private key remains local; only the signed public transaction is submitted.

Consensus validates:

1. protocol v5 is active at the target height;
2. the transaction uses the version-2 mining signing domain;
3. sender/public-key derivation and account nonce are exact;
4. the target height is the exact next height;
5. `previousHash` equals the current finalized tip;
6. the reward exactly matches the deterministic claim-count halving schedule;
7. the work hash satisfies the target;
8. no earlier mining claim is already present in the same block;
9. historical genesis-plus-mining issuance cannot exceed 50,000,000 ZYN.

Mining work is bound to the miner address/public key, so a competing wallet cannot simply replace the payout address and steal a discovered nonce. It is also bound to the previous finalized block, so work cannot be prepared indefinitely before the preceding tip exists and stale work becomes invalid after finality advances.

The initial 20-bit target is deliberately simple and **not network-adaptive in this version**. It must be calibrated under adversarial public-testnet conditions before mainnet economics are frozen. Faster hardware can find eligible claims much more quickly than slower hardware, and validator transaction censorship remains possible. These are explicit limitations of the initial hybrid design.

The standalone miner in `l1/scripts/mine.mjs` decrypts a local ZyronChain keystore, performs work locally, abandons stale challenges when the tip changes and signs/submits only the resulting mining transaction. Remote RPC requires HTTPS; plaintext HTTP is accepted only for loopback.

## 10. Proof of Activity

Activity settlement uses oracle-signed receipt-root batches. A settlement can spend only the prefunded activity pool and cannot increase total supply.

Before public-testnet activation, either:

- the feature remains disabled/unfunded; or
- independent receipt services and oracle governance are deployed and audited.

A founder-controlled oracle is incompatible with founder-independent operation.

## 11. Networking

The preferred node data plane uses libp2p TCP, Noise and yamux.

Native sessions bind:

- Noise-authenticated PeerId;
- persistent node public key;
- chain ID;
- genesis hash.

The implementation includes bounded connection upgrades, streams, request rates, response sizes, fanout, deduplication, inflight work and dial concurrency. Configured bootstrap peers pin PeerIds. Discovery candidates must pass identity and network checks before admission.

Peer scoring, backoff, topology buckets and operator-supplied failure domains reduce eclipse concentration. They do not create decentralization by themselves; independent operators and infrastructure are required.

## 12. RPC boundary

Wallet/public HTTP RPC and validator consensus networking are separate security surfaces.

RPC responses advertise an explicit API version. Unsupported requested versions receive HTTP 426. Public RPC is resource bounded and intended to sit behind a separately controlled TLS/rate-limiting perimeter.

Consensus writes require authenticated peer credentials when exposed beyond loopback. Bearer tokens are a legacy/private deployment option; signed node identity or native P2P is preferred.

A miner using a remote public RPC submits only signed mining transactions and must use HTTPS. Mining does not justify exposing validator-control RPC publicly.

## 13. Checkpoints, pruning and light clients

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

## 14. Keys

Production validators should use a pinned remote signer or HSM boundary. The node verifies every returned signature against the exact public key, payload, intent and protocol domain.

The anti-equivocation journal is persisted before a remote signing request. A signer outage may sacrifice liveness for one action but must not permit a conflicting signature after restart.

Local operator and miner keys may use scrypt-derived AES-256-GCM keystores with authenticated public-key/address metadata and bounded password files. This is not a substitute for production HSM custody where validator keys are concerned.

## 15. Persistence and recovery

Finalized records are validated, durably appended and only then applied to live state. Ambiguous persistence outcomes fail stop until restart.

A SQLite writer lease prevents concurrent node, snapshot and prune writers from mutating one data directory. Replay, checkpoint restoration, State-v2 rebuild and protocol rollback are regression tested.

Protocol-v5 recovery must reproduce the same miner balances and consensus-owned finalized mining-claim counter from authenticated State-v2. A restart cannot derive mining headroom from current balances or resurrect fee-burned ZYN.

Operators must retain independent archive nodes and rehearse restore, suffix catch-up and key-compromise procedures.

## 16. Releases

CI runs TypeScript checks and tests on Node.js 22 and 24, audits runtime dependencies and runs the independent Python verifier.

Tags matching `l1-v*` produce:

- deterministic npm tarball;
- SPDX runtime SBOM;
- SHA-256 manifest;
- GitHub artifact attestations.

A clean external-directory rehearsal installs only the packaged tarball, proves organic two-validator finality and proves restart/recovery without source-tree runtime files. Release provenance and artifact rehearsals prove what was built and that it can be operated; they do not prove consensus correctness or independently close activation gates.

## 17. Founder independence

The network is not founder-independent until:

- founders do not control a validator quorum or unique recovery key;
- validator, bootstrap, archive, explorer and checkpoint services span independent operators;
- source/release/security governance has succession;
- activity-oracle control is distributed or disabled;
- third parties can build, restore, rotate, upgrade, mine and release without private assistance;
- genesis, mining rules and economics are immutable and publicly reproducible.

Permissionless mining removes the need for a founder-controlled mint/distribution key, but it does not by itself remove validator or infrastructure control.

The repository includes a public independent-operator challenge and maintainer/security succession policy. Their CI verifies policy/evidence shape, but deliberately does not claim that real independent custody or operator independence has already been achieved.

Founder withdrawal must preserve public history and audit evidence.

## 18. Launch gates

Governance authorization for both the public-testnet and mainnet network classes is recorded in `docs/l1-launch-authorization.json`. The same policy currently keeps both activation flags false.

Public-testnet activation still requires independent operator deployment, multi-domain bootstrap/archive infrastructure, independent security review/retest, sustained adversarial Internet evidence, production signer custody and protected release/review policy. The connected Render Free profile is smoke-only; a separate hosted-duration evidence verifier is prepared for reviewed always-on infrastructure, but synthetic CI cannot satisfy the real uptime gate.

Protocol-v5 mining code being present in a release **does not activate public mining**. The public network must first activate the reviewed protocol schedule and satisfy the launch gates. Testnet mining must collect real contention, stale-work, censorship, hardware-skew and RPC-abuse evidence before the 20-bit target or any future retarget policy is considered mainnet-ready.

A value-bearing mainnet additionally requires all public-testnet activation requirements plus immutable chain ID/genesis profile, zero-premine or explicitly disclosed allocation policy, mining/halving/target economics, oracle/validator-governance specifications, target-hardware State-v2 evidence, multi-region recovery/incident evidence and independent maintainer/security custody succession.

The authoritative checklist is [`docs/STANDALONE_L1_READINESS.md`](docs/STANDALONE_L1_READINESS.md); launch authorization is [`docs/L1_LAUNCH_AUTHORIZATION.md`](docs/L1_LAUNCH_AUTHORIZATION.md); the threat assumptions are [`docs/L1_THREAT_MODEL.md`](docs/L1_THREAT_MODEL.md); mining mechanics are [`docs/MINING.md`](docs/MINING.md).
