import assert from "node:assert/strict";
import test from "node:test";

import { NodeService } from "../src/node-base.js";
import type { ChainStore } from "../src/storage.js";
import type { Block, MiningClaimTx, TransferTx } from "../src/types.js";

const oldTipHash = "a".repeat(64);
const finalizedTipHash = "d".repeat(64);
const minerOne = `ZYN${"1".repeat(40)}`;
const minerTwo = `ZYN${"2".repeat(40)}`;
const wallet = `ZYN${"3".repeat(40)}`;
const receiver = `ZYN${"4".repeat(40)}`;

function miningClaim(sender: string, txidDigit: string, height: number, previousHash: string): MiningClaimTx {
  return {
    kind: "mining_claim",
    version: 2,
    chainId: "zyron-mining-prune-test",
    nonce: 1,
    sender: sender as MiningClaimTx["sender"],
    height,
    previousHash,
    rewardAtoms: 625_000_000,
    workNonce: "0000000000000000",
    feeAtoms: 0,
    timestampMs: 1_700_000_000_001,
    publicKey: "11".repeat(64),
    signature: "22".repeat(64),
    txid: txidDigit.repeat(64)
  };
}

function transfer(): TransferTx {
  return {
    kind: "transfer",
    version: 1,
    chainId: "zyron-mining-prune-test",
    nonce: 1,
    sender: wallet as TransferTx["sender"],
    receiver: receiver as TransferTx["receiver"],
    amountAtoms: 1,
    feeAtoms: 1,
    timestampMs: 1_700_000_000_001,
    publicKey: "33".repeat(64),
    signature: "44".repeat(64),
    txid: "e".repeat(64)
  };
}

function finalizedBlock(): Block {
  return {
    header: {
      version: 1,
      chainId: "zyron-mining-prune-test",
      height: 1,
      round: 0,
      previousHash: oldTipHash,
      timestampMs: 1_700_000_000_100,
      transactionRoot: "b".repeat(64),
      stateRoot: "c".repeat(64),
      proposer: "GENESIS"
    },
    transactions: [],
    hash: finalizedTipHash,
    proposerPublicKey: null,
    signature: null,
    roundCertificate: [],
    attestations: []
  };
}

// RETIRED (owner decision 2026-09-30): mining claims can no longer enter the
// mempool at all, so there are no stale claims to prune. This test previously
// proved losing claims were pruned on finalization; it now proves the node
// mempool refuses every claim (stale tip and next tip) while ordinary transfers
// still flow through finalization unaffected.
test("node mempool refuses mining claims for any tip (mining retired) and finalization keeps unrelated transactions", async () => {
  let height = 0;
  let tipHash = oldTipHash;
  const confirmedNonces = new Map<string, number>();
  const fakeStore = {
    chain: {
      get height() { return height; },
      get tip() { return { hash: tipHash }; },
      nonce(address: string) { return confirmedNonces.get(address) ?? 0; }
    },
    async commitFinalizedBlock(block: Block) {
      height = block.header.height;
      tipHash = block.hash;
    }
  } as unknown as ChainStore;

  const service = new NodeService(fakeStore);
  const staleOne = miningClaim(minerOne, "5", 1, oldTipHash);
  const staleTwo = miningClaim(minerTwo, "6", 1, oldTipHash);
  const unrelatedTransfer = transfer();

  assert.throws(() => service.mempool.add(staleOne), /Mining is retired/);
  assert.throws(() => service.mempool.add(staleTwo), /Mining is retired/);
  service.mempool.add(unrelatedTransfer);
  assert.equal(service.mempool.size, 1);

  await service.acceptFinalizedBlock(finalizedBlock());

  const remaining = service.mempool.values();
  assert.equal(service.mempool.size, 1);
  assert.deepEqual(remaining.map((tx) => tx.txid), [unrelatedTransfer.txid]);

  const nextTipClaim = miningClaim(minerOne, "7", 2, finalizedTipHash);
  assert.throws(() => service.mempool.add(nextTipClaim), /Mining is retired/);
  assert.equal(service.mempool.size, 1);
  assert.ok(!service.mempool.values().some((tx) => tx.kind === "mining_claim"));
});
