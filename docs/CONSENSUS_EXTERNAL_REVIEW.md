# External review package — round-change liveness

Review the prepare/commit machine. Do not treat a green test run as a proof.

## Read first

1. `docs/CONSENSUS_STATE_MACHINE.md` — baseline halt and the new phases.
2. `docs/CONSENSUS_ROUND_CHANGE_DESIGN.md` — approaches A–E and why A with the higher-round unlock was chosen.
3. `docs/CONSENSUS_SAFETY_LIVENESS_REVIEW.md` — invariants, fault bound, mixed-version, limitations.
4. `docs/PUBLIC_TESTNET_DOUBLE_HASH_REVIEW.md` — the bound that still forces completion to return null.
5. `docs/CONSENSUS_CERTIFICATE_MODEL.md` — quorum formula. It must stay `floor(2N/3)+1`.

## Code

- `l1/src/round-view-change.ts` — votes, certificate uniqueness, lock rule, bounded search, S1–S10.
- `l1/src/lock-certificate-store.ts` — fsync of the prepare quorum.
- `l1/src/storage.ts` — journal kinds `prepare` and `view`, write-before-send.
- `l1/src/node-base.ts` — `prepareProposal`, `attestProposal`, `requestViewChange`, `attestCompletion`, `tryCompleteSplitRound`, `collectPredecessorRoundCertificate`, `finalizeLockedHash`.
- `l1/src/block.ts` — `validateRoundCertificate` rejects a new block whose view-change still carries a lock.
- `l1/src/p2p-consensus.ts` — protocol `/zyronchain/consensus/1.1.0`.

## Reproduce

From `l1/`:

```
npm ci
npm test
node --test --test-timeout=600000 dist/test/round-double-hash-liveness-regression.test.js dist/test/consensus-safety-invariants.test.js dist/test/split-vote-liveness.test.js
```

The old halt is the N=4 2+2 case and the N=7 3+3+1 case in the regression file. Completion of those observations is null. One later hash finalizes. A second finalized hash at that height is rejected.

## What would still be a stop-ship

Any test or review that shows two finalized hashes at one height, a commit quorum without `Q` attestations, an honest validator signing two commits, a nil view-change while a commit quorum exists, or a lock released without a higher-round prepare quorum. Keep that reproducer. Do not lower quorum to make it pass.

## Explicit non-goals

Mixed-version operation is **not supported**. Economics and activation flags are out of scope and must stay as they are. This package does not authorize a public testnet launch.
