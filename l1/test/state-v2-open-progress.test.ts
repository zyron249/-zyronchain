// Codex review on #1060 (P2): when ChainStore.open has to rebuild the derived
// State-v2 store (a restored validator copy has none), it wrote every node
// record of the replayed state in one synchronous SQLite transaction, with no
// progress report and without yielding to the event loop. With a large enough
// state that single step could outlast the open-testnet boot liveness window
// (and block health checks), so a healthy restore would look stalled.
//
// The rebuild must write in bounded batches, report progress per batch and
// yield to the event loop between batches. What is stored must not change.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";
import { ChainStore } from "../src/storage.js";

const key = (n: number) => n.toString(16).padStart(64, "0");
const validatorOnePrivate = key(1);
const validatorTwoPrivate = key(2);
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);
const activityPool = addressFromPublicKey(publicKeyFromPrivate(key(3)));
const ACCOUNTS = 3_000;

function genesis(): GenesisConfig {
  const allocations = [{ address: activityPool, amountAtoms: 5_000_000_000 }];
  for (let i = 0; i < ACCOUNTS; i += 1) allocations.push({ address: addressFromPublicKey(publicKeyFromPrivate(key(1_000 + i))), amountAtoms: 1_000 });
  return {
    chainId: "zyron-state-v2-open-progress-1",
    timestampMs: 1_700_000_000_000,
    validators: [
      { address: validatorOne, publicKey: validatorOnePublic },
      { address: validatorTwo, publicKey: validatorTwoPublic }
    ],
    activityOracles: [publicKeyFromPrivate(key(4))],
    activityPool,
    allocations
  };
}

test("ChainStore.open rebuilds a missing State-v2 store in batches, reporting progress and yielding between batches", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-open-progress-"));
  try {
    const config = genesis();
    const store = await ChainStore.open(config, directory);
    const proposal = { chainId: config.chainId, nonce: 1, sender: validatorOne, activationHeight: 101, protocolVersion: 2 };
    const upgrade = createProtocolUpgrade({
      ...proposal,
      approvals: [
        createProtocolUpgradeApproval(proposal, validatorOnePrivate, validatorOnePublic),
        createProtocolUpgradeApproval(proposal, validatorTwoPrivate, validatorTwoPublic)
      ],
      timestampMs: config.timestampMs + 1
    }, validatorOnePrivate, validatorOnePublic);
    for (let height = 1; height <= 101; height += 1) {
      const proposerKey = height % 2 === 1 ? validatorOnePrivate : validatorTwoPrivate;
      let block = store.chain.produceBlock(height === 1 ? [upgrade] : [], proposerKey, { timestampMs: config.timestampMs + height * 100 });
      block = store.chain.attestBlock(block, validatorOnePrivate);
      block = store.chain.attestBlock(block, validatorTwoPrivate);
      await store.commitFinalizedBlock(block, config.timestampMs + height * 100);
    }
    const expectedRoot = store.chain.tip.header.stateRoot;
    const nodeCount = store.chain.stateV2ForPersistence()!.nodeRecords().length;
    assert.ok(nodeCount > 2 * 1_024, `fixture state too small (${nodeCount} nodes)`);
    // Like a restored validator copy: the finalized log only, no derived State-v2 store.
    for (const file of await readdir(directory)) {
      if (file.startsWith("state-v2")) await rm(join(directory, file), { recursive: true, force: true });
    }

    // Every batch must be followed by an event-loop turn before the next one:
    // each callback schedules a setImmediate and the next callback checks it ran.
    let batches = 0;
    let yielded = true;
    let withoutYield = 0;
    const reopened = await ChainStore.open(config, directory, {
      onStateV2Batch: () => {
        batches += 1;
        if (!yielded) withoutYield += 1;
        yielded = false;
        setImmediate(() => { yielded = true; });
      }
    });
    // Bounded steps: no single write of more than 4096 node records or 4096 keys.
    const minimumBatches = Math.ceil(nodeCount / 4_096) + Math.ceil(ACCOUNTS / 4_096);
    assert.ok(batches >= minimumBatches, `State-v2 rebuild of ${nodeCount} nodes reported ${batches} progress batch(es), expected at least ${minimumBatches}`);
    assert.equal(withoutYield, 0, "the State-v2 rebuild did not yield to the event loop between batches");
    assert.equal(reopened.chain.height, 101);
    assert.equal(reopened.chain.stateV2ForPersistence()?.root(), expectedRoot);
    // The rebuilt store is complete: a plain reopen needs no rebuild and has the same root.
    let again = 0;
    const plain = await ChainStore.open(config, directory, { onStateV2Batch: () => { again += 1; } });
    assert.equal(plain.chain.stateV2ForPersistence()?.root(), expectedRoot);
    assert.equal(again, 0, "a complete State-v2 store was rebuilt again");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
