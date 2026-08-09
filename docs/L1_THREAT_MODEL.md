# ZyronChain standalone L1 threat model

Status: **pre-public-testnet security specification**  
Scope: canonical TypeScript implementation in `l1/`  
Non-goal: this document does not authorize a public testnet, mainnet genesis, token sale or validator admission.

## 1. Protected assets

The system must preserve:

1. one deterministic finalized history for a given genesis;
2. exact account balances, nonces and the 50,000,000 ZYN genesis supply ceiling;
3. authenticated State-v2 roots and semantic-key preimages;
4. transaction, validator, protocol and activity authorization;
5. finality and certified-view-change quorum rules;
6. validator anti-equivocation state across crash and restart;
7. chain ID, genesis hash, protocol schedule and validator schedule;
8. independently anchored checkpoint and light-client trust;
9. validator, node-identity, wallet and activity-oracle private keys;
10. availability without weakening safety to recover liveness.

## 2. Security model

ZyronChain currently uses a permissioned validator set.

For `N` active validators, finality and governance require `floor(2N/3)+1` unique valid signatures. Safety assumes an adversary cannot obtain a finality quorum. Liveness assumes enough honest validators remain online and can communicate within the documented timing model.

This is not proof-of-work, proof-of-stake or permissionless validator admission. Validator count alone is not decentralization. Operators sharing an owner, cloud, network, jurisdiction, signer or recovery process may fail as one domain.

No implementation claim may equate this model with Bitcoin's mining decentralization or battle-tested security.

## 3. Trust assumptions

### Consensus

- At most the tolerated Byzantine fraction signs conflicting or invalid actions.
- Honest validators run compatible binaries for the active protocol.
- Validator hosts preserve signing-journal and remote-signer anti-equivocation state.
- Clocks remain within the monitored future-skew and round-timing assumptions.
- Validator-set and protocol changes receive genuine current-set quorum approval.

### State and storage

- Finalized history, or an independently authenticated checkpoint plus validated suffix, remains available.
- SQLite and filesystem locking/fsync semantics match the supported deployment profile.
- Operators do not bypass persistence-health failures, writer leases or signing journals.
- State-v2 reconstruction is accepted only when its root and semantic view match finalized consensus data.

### Networking

- Noise authenticates the connected PeerId, but an authenticated peer may still be malicious.
- Bootstrap identities and named failure domains are obtained out of band.
- Peer discovery is availability metadata, never authority for genesis, validator, checkpoint or protocol trust.
- Operators deploy enough independent bootstrap/archive nodes to survive the loss of any founder-operated infrastructure.

### Cryptography and keys

- SHA-256, secp256k1, AES-256-GCM and scrypt remain secure for their documented use.
- Production validator keys are held by independently controlled HSM/audited remote signers.
- Local encrypted keystores are a development/operator fallback, not HSM certification.
- Password files, keystores and backups are stored in separate security domains.

## 4. Adversaries

The implementation must expect:

- unauthenticated Internet clients sending malformed, oversized, slow or high-rate RPC/P2P traffic;
- authenticated Byzantine peers lying about height, blocks, state, checkpoints, discovery and availability;
- eclipse/Sybil operators controlling many addresses or identities;
- compromised validators attempting double-finality, governance capture or censorship;
- compromised activity oracles attempting unauthorized pool distribution;
- attackers replaying signatures across chain, intent, transaction kind, protocol version or request path;
- malicious or buggy old binaries around protocol activation;
- disk corruption, truncated writes, stale derived state and ambiguous fsync outcomes;
- clock skew and delayed/reordered messages;
- dependency, CI, release-token and artifact substitution attacks;
- operator mistakes, copied data directories, reused keys and incorrect restores;
- founder disappearance, domain expiry, repository loss and bootstrap/checkpoint unavailability.

## 5. Consensus safety invariants

The certificate-level quorum/view-change argument is exhaustively checked for practical validator counts by [`CONSENSUS_CERTIFICATE_MODEL.md`](CONSENSUS_CERTIFICATE_MODEL.md) and its executable test. This is bounded evidence, not a substitute for implementation review or real-network fault injection.

The following are stop-ship invariants:

- two conflicting blocks cannot both satisfy finality at one height under the fault assumption;
- a validator cannot attest and skip the same `(height, round)`;
- non-zero rounds require the immediately preceding valid skip certificate;
- blocks use the scheduled proposer and exact active validator set;
- every finalized block re-executes to its committed transaction and state roots;
- unsupported active protocol versions fail closed;
- validator/protocol changes activate only after quorum authorization and delay;
- replay/restart reconstructs identical state and schedules;
- rollback transitions preserve authenticated balances, nonces and governance state.

A failure of any invariant freezes release and validator signing until independently reviewed.

## 6. Monetary invariants

- Genesis allocations never exceed 50,000,000 ZYN in atoms.
- Transfers cannot create value.
- Fees are burned under the current policy.
- Activity settlement can spend only an explicitly prefunded activity pool.
- Transaction IDs and signatures bind the exact canonical transaction.
- Sender nonces are sequential and chain-specific.
- No admin, validator, oracle, release process or recovery operation has a hidden mint path.

Genesis allocation, validator compensation, future fee changes and activity-oracle policy are governance decisions that must be frozen publicly before mainnet.

## 7. Checkpoint and light-client trust

A peer is never a sufficient trust anchor.

Checkpoint/state installation requires an independently obtained finalized tip hash and snapshot digest. The installer validates identity, finality, governance schedules and state roots before publishing a new data directory.

Light clients begin from an independently authenticated anchor containing chain/genesis identity, height/hash/state root, protocol version and validator set. Validator-set transitions require authenticated State-v2 evidence. Future protocol semantics require a reviewed compatible client and cannot be guessed from peer data.

## 8. Founder-exit threats

The network is not founder-independent while any of these are true:

- founders control a validator quorum or unique recovery/admin key;
- all bootstrap, archive, explorer, checkpoint or release infrastructure is founder-operated;
- the activity oracle depends on a founder;
- source, domains, release credentials or security contact have no succession;
- third parties cannot build, restore, upgrade and rotate validators without private assistance;
- governance decisions exist only in private conversations;
- genesis or allocation can be changed unilaterally.

Founder exit must be a verified transfer of operational capability, not deletion of evidence. Git history, audit records, release attestations and public genesis preparation must remain available.

## 9. Public-testnet entry criteria

A public testnet remains blocked until:

1. canonical L1 documentation and legacy separation are complete;
2. fault-injection and long-running multi-node harnesses cover partition, crash, corruption, clock and upgrade scenarios;
3. independent operators can deploy from release artifacts without founder assistance;
4. bootstrap, archive and monitoring infrastructure spans independent failure domains;
5. validator key rotation and disaster recovery are rehearsed;
6. State-v2 scale and recovery limits are measured on target hardware;
7. unresolved known critical/high implementation findings are absent.

## 10. Mainnet entry criteria

In addition to public-testnet evidence:

- immutable genesis, allocation, chain ID and economic specification are published;
- validator admission/removal and activity-oracle governance are public;
- production HSM/remote-signer custody is independently audited;
- sustained adversarial testnet and bug bounty are complete;
- independent consensus, cryptography and networking reviews have no unresolved critical/high findings;
- multi-region operators demonstrate restore, upgrade, rollback and incident response;
- protected release and maintainer-succession policy is active;
- third parties independently reproduce release artifacts and replay long histories.

## 11. Incident posture

Safety outranks liveness. Operators must not lower quorum, delete journals, patch hashes, accept peer-provided trust anchors or improvise emergency mint/admin authority. Conflicting finalized tips, equivocation, supply divergence or unexplained state-root disagreement are critical incidents requiring signing freeze and evidence preservation.
