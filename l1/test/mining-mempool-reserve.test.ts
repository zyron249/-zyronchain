import assert from "node:assert/strict";
import test from "node:test";

import { Mempool } from "../src/mempool.js";
import type { MiningClaimTx, TransferTx } from "../src/types.js";

const chainId = "zyron-mining-reserve-test";

function transfer(index: number): TransferTx {
  return {
    kind: "transfer",
    version: 1,
    chainId,
    nonce: 1,
    sender: `ZYN${index.toString(16).padStart(40, "0")}` as TransferTx["sender"],
    receiver: `ZYN${(index + 100).toString(16).padStart(40, "0")}` as TransferTx["receiver"],
    amountAtoms: 1,
    feeAtoms: 1,
    timestampMs: 1_700_000_000_000 + index,
    publicKey: "11".repeat(64),
    signature: "22".repeat(64),
    txid: index.toString(16).padStart(64, "0")
  };
}

function miningClaim(index: number): MiningClaimTx {
  return {
    kind: "mining_claim",
    version: 2,
    chainId,
    nonce: 1,
    sender: `ZYN${(index + 500).toString(16).padStart(40, "0")}` as MiningClaimTx["sender"],
    height: 1,
    previousHash: "ab".repeat(32),
    rewardAtoms: 625_000_000,
    workNonce: index.toString(16).padStart(16, "0"),
    feeAtoms: 0,
    timestampMs: 1_700_000_001_000 + index,
    publicKey: "33".repeat(64),
    signature: "44".repeat(64),
    txid: (index + 10_000).toString(16).padStart(64, "0")
  };
}

test("reserved mining capacity remains available when non-mining capacity is saturated", () => {
  const mempool = new Mempool(2, 1);
  const firstTransfer = transfer(1);
  const secondTransfer = transfer(2);
  const claim = miningClaim(1);

  mempool.add(firstTransfer);
  mempool.add(secondTransfer);
  assert.equal(mempool.size, 2);

  mempool.add(claim);
  assert.equal(mempool.size, 3);
  assert.ok(mempool.values().some((tx) => tx.txid === claim.txid));
  assert.ok(mempool.values().some((tx) => tx.txid === firstTransfer.txid));
  assert.ok(mempool.values().some((tx) => tx.txid === secondTransfer.txid));
});

test("mining reserve stays bounded when a stronger claim replaces the weakest claim", () => {
  const mempool = new Mempool(1, 1);
  const normal = transfer(1);
  mempool.add(normal);
  mempool.add(miningClaim(1));

  try {
    mempool.add(miningClaim(2));
  } catch (error) {
    assert.match(String(error), /Mining mempool full/);
  }

  assert.equal(mempool.size, 2);
  assert.ok(mempool.values().some((tx) => tx.txid === normal.txid));
  assert.equal(mempool.values().filter((tx) => tx.kind === "mining_claim").length, 1);
});

test("custom mempool capacity remains a hard total cap unless a mining reserve is explicitly configured", () => {
  const mempool = new Mempool(1);
  mempool.add(transfer(1));
  assert.throws(() => mempool.add(miningClaim(1)), /Mining mempool full/);
  assert.equal(mempool.size, 1);
});
