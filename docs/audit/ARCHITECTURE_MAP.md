# ZyronChain L1 Architecture Map (Independent Audit 2026-09-28)

**Audited tip (pre-audit commits):** `d6aa19e` on `cursor/round-view-change-liveness-068e` (PR #904 stack including #903).  
**Audit branch:** `audit/security-20260928`  
**Canonical implementation:** TypeScript `l1/` (not Python `app.py` / Flask).  
**Ticker:** `ZYN`. **Hard cap:** `MAX_SUPPLY_ATOMS = 50_000_000 * ATOMS_PER_ZYN` (`l1/src/types.ts`).

## High-level components

| Layer | Primary files | Role |
| --- | --- | --- |
| Types / economics constants | `types.ts`, `mining.ts` | Addresses, txs, blocks, supply + PoW issuance schedule |
| Codec / crypto | `codec.ts`, `crypto.ts`, `validator-signer.ts` | Canonical JSON, SHA-256, secp256k1, domain-separated signing |
| Transactions | `transaction.ts`, `mempool.ts` | Shape/sig validation, mempool admission/replacement |
| State | `state.ts`, `state-v2*.ts` | Legacy ledger + sparse Merkle State v2 |
| Blocks / quorum | `block.ts` | Proposal, attestations, skip/uncommitted certs, quorum math |
| View-change (PR #904) | `round-view-change.ts`, `lock-certificate-store.ts`, `round-proposal-store.ts` | Prepare/commit, VC certificates, bounded safety search |
| Chain | `chain.ts` | Apply txs, schedules, mining context, genesis validation |
| Node / RPC | `node-base.ts`, `node.ts`, `public-testnet-rpc.ts` | Validator service, HTTP RPC, rate-limit, proxy trust |
| Storage / journal | `storage.ts` | Finalized log, signing journal, leases, fsync hooks |
| P2P | `p2p*.ts`, `peer-*.ts` | Native libp2p consensus/sync/discovery + HTTP peers |
| Governance / testnet | `public-testnet-*.ts`, `cli.ts` | Upgrades, provisioning, operator scaffolding |

## Consensus critical functions

1. **`validatorQuorumSize(N)`** → `floor(2N/3)+1` — never lowered.
2. **`validatePrepareQuorum` / `createPrepareVote`** — prepare is not commit.
3. **`validateAttestationQuorum` / `attestationPayload`** — only path that finalizes a hash.
4. **`validateViewChangeCertificate`** — nil lock may open next round; locked VC must finalize lock (S8).
5. **`uniquePossiblyFinalizedHash` / `uniquePossiblyFinalizedWithPrepares`** — completion refuses if another hash could still reach quorum.
6. **`commitAllowedByLock`** — conflicting later commit needs strictly higher prepare round.
7. **`SigningJournal.reserve*`** — durable anti-equivocation before signature release.
8. **`writeLockCertificate`** — durable prepare quorum justifying a commit/lock.
9. **`NodeService.attestProposal` / `requestViewChange` / `produceFinalizedBlock`** — live state machine.
10. **`validateBlockEnvelope`** — chain linkage, proposer, round cert, optional finality.
11. **`assertMiningClaimContext` / `miningRewardAtoms`** — only mint path besides genesis.
12. **`validateGenesis` / `LedgerState.fromGenesis`** — chain identity + supply ceiling.
13. **`classifyRpcRoute` / `assertSafeRpcBinding` / `preauthorizeConsensusRequest`** — RPC trust boundary.
14. **`signCanonicalDomain` / `transactionSigningDomain` / consensus domains** — cross-type / cross-chain separation.

## Quorum / fault model

- `f = floor((N-1)/3)`, `Q = floor(2N/3)+1`.
- Honest intersection of two quorums minus `f` is `>= 1` for N in 1..100 (tested).
- N≤3 ⇒ `f=0` (no Byzantine tolerance).

## Mint / burn paths

| Path | Mints? | Notes |
| --- | --- | --- |
| Genesis allocations | Yes (one-shot) | Capped by `MAX_SUPPLY_ATOMS`; tracker banned |
| `mining_claim` | Yes | Schedule-derived `rewardAtoms`; tip-bound PoW |
| `transfer` | No | Fees burned (debited, never credited) |
| `activity_settlement` | No | Redistributes from activity pool |
| `validator_update` / `protocol_upgrade` | No | Nonce-only ledger effects |

## PR #904 delta vs `main` (summary)

- New `round-view-change.ts` (prepare/VC, bounded explorer, SAFETY_INVARIANTS).
- Large `node-base.ts` changes: prepare→commit, VC routes, lock certs, split completion.
- Types: `PrepareVote`, `ViewChangeVote`, lock evidence.
- Qualification / split-vote / gate1 tests; public-testnet scaffolding.
- Intent: fix round-change liveness for split quorum states without lowering Q.

## Trust boundaries

- **PUBLIC:** status/protocol/health, balance/nonce, `/tx`.
- **CONSENSUS:** prepare/attest/skip/view/lock/report/complete/block (auth required off-loopback via CLI).
- **OPERATOR:** metrics/peers/blocks.
- **INTERNAL:** signing journal, lock certs, keystore, remote signer bearer token.
