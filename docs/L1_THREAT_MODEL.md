# ZyronChain standalone L1 threat model

Status: **pre-public-testnet security specification**  
Scope: canonical TypeScript implementation in `l1/`  
Non-goal: this document does not authorize a public testnet, mainnet genesis, token sale, public mining activation or validator admission.

## 1. Protected assets

The system must preserve:

1. one deterministic finalized history for a given genesis;
2. exact account balances, nonces and the 50,000,000 ZYN **historical issuance ceiling**;
3. the exact protocol-v5 finalized mining-claim counter and miner rewards;
4. authenticated State-v2 roots and semantic-key preimages;
5. transaction, validator, protocol, mining and activity authorization;
6. finality and certified-view-change quorum rules;
7. validator anti-equivocation state across crash and restart;
8. chain ID, genesis hash, protocol schedule and validator schedule;
9. independently anchored checkpoint and light-client trust;
10. validator, node-identity, wallet/miner and activity-oracle private keys;
11. availability without weakening safety to recover liveness.

## 2. Security model

ZyronChain currently uses a permissioned validator set for block proposal and finality.

For `N` active validators, finality and governance require `floor(2N/3)+1` unique valid signatures. Safety assumes an adversary cannot obtain a finality quorum. Liveness assumes enough honest validators remain online and can communicate within the documented timing model.

Protocol v5 additionally permits **permissionless proof-of-work ZYN issuance claims**. Mining is not the chain-selection algorithm: hash power does not select the proposer, replace validator attestations or determine the canonical fork. Any key holder may compete to earn a mining claim, but validators still decide which valid transactions are ordered into finalized blocks.

This is therefore not proof-of-stake or Nakamoto proof-of-work consensus, and validator admission is not permissionless. Validator count alone is not decentralization. Operators sharing an owner, cloud, network, jurisdiction, signer or recovery process may fail as one domain.

No implementation claim may equate this hybrid model with Bitcoin's mining decentralization or battle-tested security.

## 3. Trust assumptions

### Consensus

- At most the tolerated Byzantine fraction signs conflicting or invalid actions.
- Honest validators run compatible binaries for the active protocol.
- Validator hosts preserve signing-journal and remote-signer anti-equivocation state.
- Clocks remain within the monitored future-skew and round-timing assumptions. A backward jump beyond one second fail-stops validator signing for the lifetime of the process.
- Validator-set and protocol changes receive genuine current-set quorum approval.
- Protocol v4 remains unsupported/fail-stop; mining is accepted only once an authorized protocol-v5 schedule is active.
- Validators re-execute mining proof, tip binding, claim count and deterministic reward rather than trusting miner-provided economics.

### Mining and monetary issuance

- SHA-256 preimage resistance holds for the issuance proof-of-work challenge.
- A mining claim is useful only for the exact current finalized tip, next height, miner identity/account nonce and scheduled reward.
- The consensus-owned reserved address `ZYN0000000000000000000000000000000000000000` remains non-spendable and non-fundable; only its nonce may advance as the finalized global mining-claim counter.
- Genesis allocations reduce the remaining mining budget atom-for-atom.
- Fee burns do not reduce historical issuance and therefore never reopen mining headroom.
- The initial fixed 20-bit mining target is a launch/testnet calibration choice, not evidence of hardware fairness or Sybil resistance.
- At most one mining claim may be finalized in a block.

### State and storage

- Finalized history, or an independently authenticated checkpoint plus validated suffix, remains available.
- SQLite and filesystem locking/fsync semantics match the supported deployment profile.
- Operators do not bypass persistence-health failures, writer leases or signing journals. Readiness fails closed on persistence uncertainty or validator clock faults while liveness remains separately observable.
- State-v2 reconstruction is accepted only when its root and semantic view match finalized consensus data.
- Protocol-v5 recovery reproduces both miner account state and the global finalized mining-claim counter.

### Networking

- Noise authenticates the connected PeerId, but an authenticated peer may still be malicious. HTTP fallback peer responses require JSON metadata, reject invalid or excessive declared lengths before streaming, remain byte-bounded individually, and share a 50 MB node-wide in-flight byte budget so concurrent malicious peers cannot multiply the per-response allowance.
- Bootstrap identities and named failure domains are obtained out of band.
- Peer discovery is availability metadata, never authority for genesis, validator, checkpoint or protocol trust.
- Public RPC availability assumes layered perimeter controls; the node additionally bounds individual bodies, aggregate request-body bytes retained conservatively through handler completion, aggregate queued response bytes retained until socket finish/close, rates, total connections, node-wide in-flight requests, header parsing, request/header/keep-alive time and requests per persistent socket. Signed consensus requests advertise their body SHA-256 inside the signed envelope, enabling cryptographic authentication before JSON parsing; the parsed canonical body must reproduce that hash before replay state or consensus work advances. Overload is shed with `503` before routing or body work begins; current occupancy, configured capacity and cumulative admission rejections are exposed to local monitoring.
- Mining clients treat finalized-tip RPC data as challenge input. Remote mining RPC must use TLS and remains subject to ordinary RPC availability/censorship assumptions.
- Operators deploy enough independent bootstrap/archive nodes to survive the loss of any founder-operated infrastructure.

### Cryptography and keys

- SHA-256, secp256k1, AES-256-GCM and scrypt remain secure for their documented use.
- Production validator keys are held by independently controlled HSM/audited remote signers.
- Local encrypted keystores are a development/operator/miner fallback, not HSM certification.
- Password files, keystores and backups are stored in separate security domains.

## 4. Adversaries

The implementation must expect:

- unauthenticated Internet clients sending malformed, oversized, slow or high-rate RPC/P2P traffic;
- authenticated Byzantine peers lying about height, blocks, state, checkpoints, discovery and availability;
- eclipse/Sybil operators controlling many addresses or identities;
- compromised validators attempting double-finality, governance capture, ordinary-transaction censorship or mining-claim censorship;
- miners flooding invalid/stale claims, competing with disproportionate hardware, pooling hash power or attempting to reuse/redirection-steal proofs;
- malicious RPC operators returning stale tips or selectively suppressing mining submissions;
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
- protocol-v5 mining cannot be accepted before v5 activation;
- a block cannot finalize more than one mining claim;
- a mining claim cannot target a stale tip, wrong height, wrong reward, wrong miner nonce or insufficient proof target;
- replay/restart reconstructs identical state, schedules and finalized mining-claim count;
- rollback transitions preserve authenticated balances, nonces and governance state.

A failure of any invariant freezes release and validator signing until independently reviewed.

## 6. Monetary invariants

- Historical genesis-plus-mining issuance never exceeds 50,000,000 ZYN in atoms.
- Genesis allocations consume the mining budget atom-for-atom and may be zero-valued for a zero-premine launch profile.
- Mining rewards are derived from finalized claim count: 6.25 ZYN initially, halving every 4,000,000 finalized claims, clipped permanently at the historical cap.
- The mining tracker address cannot hold spendable value, originate transactions, receive transfers/activity rewards or receive a genesis allocation.
- Transfers cannot create value.
- Fees are burned under the current policy and do not become re-mineable.
- Activity settlement can spend only an explicitly prefunded activity pool.
- Transaction IDs and signatures bind the exact canonical transaction.
- Mining work additionally binds chain, tip, target height, miner identity/account nonce and reward.
- Sender nonces are sequential and chain-specific.
- No admin, validator, oracle, release process or recovery operation has a hidden mint path.

Final genesis profile, validator compensation, mining target/retarget policy, future fee changes and activity-oracle policy are governance decisions that must be frozen publicly before mainnet.

## 7. Mining-specific abuse and censorship

Permissionless issuance introduces a new competition surface without removing validator ordering power.

Expected threats include:

- **hardware skew:** the fixed 20-bit threshold can be solved faster by stronger hardware; it is not a proof of egalitarian distribution;
- **claim races:** multiple miners may solve the same tip; only one claim can be finalized in a block;
- **validator censorship:** a proposer can omit a claim it received, and consensus cannot prove universal mempool visibility;
- **stale-work amplification:** attackers may submit large volumes of solutions for old tips; tip/height validation must reject them cheaply;
- **solution theft attempts:** replacing sender/public key invalidates the work hash and signature;
- **precomputation attempts:** the preceding finalized block hash is part of the challenge;
- **RPC manipulation:** a malicious gateway can serve stale challenge data or refuse submissions; miners should use independently operated RPCs where possible;
- **pool concentration:** mining pools can centralize issuance even though they do not directly control finality.

Before value-bearing mainnet, public-testnet evidence must measure stale rates, solution latency, validator inclusion fairness, hardware distribution, RPC abuse, target calibration and any proposed difficulty-retarget rule.

## 8. Checkpoint and light-client trust

A peer is never a sufficient trust anchor.

Checkpoint/state installation requires an independently obtained finalized tip hash and snapshot digest. The installer validates identity, finality, governance schedules and state roots before publishing a new data directory.

Light clients begin from an independently authenticated anchor containing chain/genesis identity, height/hash/state root, protocol version and validator set. Validator-set transitions require authenticated State-v2 evidence. Future protocol semantics require a reviewed compatible client and cannot be guessed from peer data.

For protocol v5, a trusted State-v2 view also commits miner balances and the global mining-claim counter. A checkpoint anchor therefore fixes issuance state at that finalized tip.

## 9. Founder-exit threats

The network is not founder-independent while any of these are true:

- founders control a validator quorum or unique recovery/admin key;
- all bootstrap, archive, explorer, checkpoint or release infrastructure is founder-operated;
- the activity oracle depends on a founder;
- source, domains, release credentials or security contact have no succession;
- third parties cannot build, restore, upgrade, rotate validators and mine without private assistance;
- governance decisions exist only in private conversations;
- genesis, mining parameters or allocation can be changed unilaterally.

Permissionless mining removes the need for a founder-controlled issuance key but does not remove validator censorship/governance power by itself.

Founder exit must be a verified transfer of operational capability, not deletion of evidence. Git history, audit records, release attestations and public genesis preparation must remain available.

## 10. Public-testnet entry criteria

A public testnet remains blocked until:

1. canonical L1 documentation and legacy separation are complete;
2. fault-injection and long-running multi-node harnesses cover partition, crash, corruption, clock and upgrade scenarios;
3. independent operators can deploy from release artifacts without founder assistance;
4. bootstrap, archive and monitoring infrastructure spans independent failure domains;
5. validator key rotation and disaster recovery are rehearsed;
6. State-v2 scale and recovery limits are measured on target hardware;
7. protocol-v5 mining is independently reviewed and tested under real multi-miner contention, stale-tip churn and validator-censorship scenarios;
8. the initial mining target is measured on representative hardware and a decision on fixed versus retargeted difficulty is documented;
9. unresolved known critical/high implementation findings are absent.

## 11. Mainnet entry criteria

In addition to public-testnet evidence:

- immutable genesis, zero-premine or explicitly disclosed allocation, chain ID and economic specification are published;
- mining reward, halving, cap and difficulty/retarget rules are frozen and independently reviewed;
- validator admission/removal and activity-oracle governance are public;
- production HSM/remote-signer custody is independently audited;
- sustained adversarial testnet and bug bounty are complete;
- independent consensus, cryptography, mining-economics and networking reviews have no unresolved critical/high findings;
- multi-region operators demonstrate restore, upgrade, rollback and incident response;
- protected release and maintainer-succession policy is active;
- third parties independently reproduce release artifacts and replay long histories.

## 12. Process-crash evidence

The persistence suite starts a separate Node.js process, commits a finalized transfer and sends SIGKILL at two exact fault hooks:

- after the finalized record write but before fsync, where restart may accept either the old prefix or the complete new record;
- after finalized-record fsync but before live-state publication, where restart must recover the new block exactly.

Both paths must reopen without a corrupt intermediate history; any recovered block must reproduce the exact tip, balance and nonce. Protocol-v5 crash/recovery evidence must additionally reproduce mining rewards and the global claim counter. Filesystem/power-loss behavior still requires deployment-hardware fault injection.

## 13. Incident posture

Safety outranks liveness. Operators must not lower quorum, delete journals, patch hashes, accept peer-provided trust anchors or improvise emergency mint/admin authority. Conflicting finalized tips, equivocation, historical issuance above 50M ZYN, mining-counter divergence, unexplained miner reward differences or state-root disagreement are critical incidents requiring signing freeze and evidence preservation.
