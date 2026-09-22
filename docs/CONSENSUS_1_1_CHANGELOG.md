# Consensus 1.1 changelog

Baseline: deployment commit `49b6002e3b13369ac36b0754a8f9f94d69906d6f` (PR #903). This branch contains that commit. The consensus diff is the files below. No deployment host, Terraform, TLS, genesis allocation, faucet, or economics file is in the diff.

Quorum stays `floor(2N/3)+1`. Economics stay 50_000_000 ZYN / 6.25 ZYN / 4_000_000 claims / 20-bit / 1 mining claim per block. Activation flags stay false.

## Production files

### `l1/src/round-view-change.ts` (new)

- Why: the baseline attestation was both a vote and a finality signature, so an ambiguous prepare-shaped split could not open another round.
- Invariant: prepare and view-change domains are not finality. S1–S10 live here. `commitAllowedByLock` refuses a conflicting commit unless `prepareQuorumRound` is strictly higher than every conflicting commit round. `validateViewChangeCertificate` returns a lock only when some counted vote carries a prepare quorum for that hash and round. Two hashes at that highest round reject the certificate.
- Wire: prepare payload `zyronchain/round-prepare/v1`. View-change payload `zyronchain/round-view-change/v1`. Protocol version `>= 3` signs with domain separation; version 1 embeds the domain inside the canonical payload. Chain genesis version 1 therefore uses the embedded form. Mining protocol 5 uses domain separation. A version-1 signature does not verify as version 5.
- Disk: none in this file.
- Restart: pure functions. Restart behavior is the journal and lock file.
- Deploy: every validator that speaks consensus must use this binary together. Mixed 1.0/1.1 is not a supported deploy.

### `l1/src/lock-certificate-store.ts` (new)

- Why: a commit lock must survive restart without treating an unsigned proposal as final.
- Invariant: the file is a prepare quorum, not a finality certificate. `removeLockCertificate` deletes the file only. A journal commit without this file refuses a nil view-change until the same quorum is supplied and rewritten.
- Wire: none.
- Disk: `dataDir/lock-certificates/<height>-<round>.json`. The file is fsynced, then the directory is fsynced.
- Restart: `readLockCertificate` reloads it. An orphan file with no journal commit is not a lock (`requestViewChange` searches journal commits first).
- Deploy: new directory beside the chain store. Absent on old data directories. Safe to start 1.1 on a directory that has never written `prepare` or `view` lines.

### `l1/src/storage.ts`

- Why: prepare and view-change must be reserved before their signatures return, and they must not share the attest/skip slot.
- Invariant: kinds `attest | skip | prepare | view`. Attest and skip still share `height:round`. Prepare and view use `height:round#prepare` and `height:round#view`. `reservePrepare` conflicts with a skip or a different attest hash. `reserveSkip` conflicts if a prepare exists. View value is `nil` or `<round>:<64 hex>`. Line cap remains 1024 bytes. `STORE_VERSION` of the block log is unchanged.
- Wire: none.
- Disk: signing journal NDJSON gains two kinds. Old files with only `attest` and `skip` still open. A 1.0 binary that rejects unknown kinds will not load a directory that already contains `prepare` or `view` lines.
- Restart: replay restores the reservations. A crash before the append returns no signature. A crash after fsync and before the caller sends the signature leaves the reservation; restart reuses it.
- Deploy: no migration tool. Rollback is redeploy of the previous binary only before any 1.1 journal line or lock file exists.

### `l1/src/types.ts`

- Why: prepare votes and view-change votes need a typed place in the round certificate.
- Invariant: `RoundProgressEntry` is skip, locked attest evidence, or view-change. `MAX_SUPPLY_ATOMS` is unchanged (`50_000_000 * ATOMS_PER_ZYN`).
- Wire: JSON objects. View-change exact keys include `prepares`, `lockRound`, `lockHash`. Prepare exact keys are the vote fields plus `signature`.
- Disk: those objects are embedded in blocks and in the lock-certificate file. The block log version is unchanged, so a block that contains a view-change certificate is a new payload inside the existing envelope.
- Restart: replay uses the existing block decoder plus the new shape checks.
- Deploy: a 1.0 node that does not know the view-change shape must not be fed these blocks. That is why mixed-version operation is rejected at the consensus protocol id rather than partially applied.

### `l1/src/block.ts`

- Why: a new-round block must be able to carry a nil view-change certificate, and must not treat a locked view-change as permission to propose a different hash.
- Invariant: round 0 still requires an empty round certificate. If every entry is a view-change, `validateViewChangeCertificate` runs and a non-nil lock throws `View-change lock must be finalized before opening a new round`. Otherwise the previous progress-certificate path runs. `validateAttestationQuorum` is unchanged and does not read view-change votes. `validatorQuorumSize` is unchanged.
- Wire: block `roundCertificate` may now be a homogeneous view-change list. Header `version` is still the chain protocol version, not `1.1.0`.
- Disk: finalized blocks with that certificate persist in the existing block log.
- Restart: validation on load uses the same function.
- Deploy: no genesis format change. Public-testnet candidate genesis stays chain protocol version 1.

### `l1/src/validator-signer.ts`

- Why: remote signers must authorize the new intents or the node must fail closed.
- Invariant: intents `round-prepare` and `round-view-change` use the same domain strings as the votes. A signer that does not authorize them cannot emit those signatures.
- Wire: signer request intent name only.
- Disk: none.
- Restart: none.
- Deploy: any external signer policy must allow the two new intents before a validator starts on 1.1. Tests that used only `block-proposal` and `block-attestation` were updated.

### `l1/src/node-base.ts`

- Why: this is the state machine. Prepare is journaled and signed before commit. View-change opens the next round only for a nil lock. A verified lock gathers commits on the original block.
- Invariant: `signPreparedProposal` retransmits a stored signed block whose prepare journal matches, and retries the signer when the journal matches an unsigned stored block. A different hash in that prepare slot throws. `attestProposal` writes the lock file, then `reserveAttestation`, then the signature. `attestCompletion` writes a lock file only when `validatePrepareQuorum` succeeds, and only after the journal reserve. Unique completion with fewer than `Q` prepares does not write a false quorum. `tryCompleteSplitRound` still hardcodes round 0. `requestViewChange` searches the commit round and, if needed, that round minus one, because a skipper's commit is journaled one round above the prepare quorum. Missing lock file plus a journal commit throws `Locked commit is missing its prepare quorum`. Timeout does not finalize. Missing votes are not no. Unseen validators are not assigned.
- Wire: routes `POST /proposal/prepare`, `POST /proposal/attest` body `{block, prepares}`, `POST /round/view` body `{height, round, previousCertificate, knownPrepares}`, `POST /round/prepare-report`, `POST /round/complete` includes prepares. Bad JSON and wrong keys return HTTP 400. Public RPC still classifies these as consensus.
- Disk: calls the journal and lock store above. No new block-log version.
- Restart: a restarted `NodeService` replays the journal and lock files. The crash regression covers commit-without-lock-file and restore-from-known-prepares.
- Deploy: local validator RPC only. Do not expose these routes on the public RPC listener.

### `l1/src/node.ts`

- Why: the HTTP peer client and the production clock path must collect prepares before commits.
- Invariant: `produceFinalizedBlock` on this module is the path tests import. It checks a lock before proposing a fresh hash and collects prepares then commits. A view-change certificate is embedded only when its highest lock is nil.
- Wire: client posts to the routes above. View-change response cap 262144 bytes. Prepare response cap 8192. Round report cap 2_500_000.
- Disk: none beyond `node-base`.
- Restart: none beyond `node-base`.
- Deploy: peer URLs stay operator-configured. This change does not add hosts.

### `l1/src/p2p-consensus.ts`

- Why: 1.0 peers must not join a 1.1 round.
- Invariant: `P2P_CONSENSUS_PROTOCOL` is `/zyronchain/consensus/1.1.0`. The handler is registered only for that id. Kinds `prepare`, `view`, and `prepare-report` were added. Attest and complete require prepares. Frame cap 2_500_000. View response cap 256 KiB. Rate 240 per 60s. Inflight 2 per peer. Outstanding 32.
- Wire: libp2p protocol select. A dial of `/zyronchain/consensus/1.0.0` fails in `newStream` before the handler runs. No consensus vote is applied.
- Disk: none.
- Restart: the protocol id is compiled in. Restart does not negotiate 1.0.
- Deploy: homogeneous 1.1. Do not run a 1.0 consensus peer against this handler and expect a partial round.

### `l1/src/cli.ts`

- Why: the CLI peer adapter must forward the new client methods or a CLI validator would skip prepares.
- Invariant: forwards `requestPrepares`, `requestAttestations(block, prepares)`, `requestViewChanges`, `requestPrepareReports`, and completion with prepares. No new CLI flag enables public testnet.
- Wire: same HTTP routes.
- Disk: none.
- Restart: none.
- Deploy: no new default peer, key, or domain.

### `l1/src/public-testnet-rpc.ts` and `l1/src/public-testnet-governance.ts`

- Why: the new routes must stay classified as consensus so the public listener returns 403.
- Invariant: `/proposal/prepare`, `/round/view`, and `/round/prepare-report` are consensus paths. Flags and economics are not read or written here.
- Wire: classification only.
- Disk: none.
- Restart: none.
- Deploy: public testnet activation is not turned on by this classification.

## What did not change

Mining constants, `MAX_SUPPLY_ATOMS`, one-claim-per-block, `MIN_PROTOCOL_UPDATE_DELAY` (100), proposer formula, `BLOCK_INTERVAL_MS`, `ROUND_WINDOW_MS`, quorum formula, reveal threshold, skip quorum, and `ROUND0_DOUBLE_HASH_CLASSIFICATION.activation` (`BLOCKS PUBLIC TESTNET`).

## Not a migration

There is no on-disk migration program. Compatibility is: old journal lines load; new journal lines do not load on a binary that rejects unknown kinds; lock files are 1.1-only; block log version is still 1.
