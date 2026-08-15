import assert from "node:assert/strict";
import test from "node:test";

import { Mempool } from "../src/mempool.js";
import type { Transaction, TransferTx } from "../src/types.js";

const chainId = "zyron-mempool-eviction-cache-test";

function transfer(index: number, feeAtoms: number): TransferTx {
  return {
    kind: "transfer",
    version: 1,
    chainId,
    nonce: 1,
    sender: `ZYN${index.toString(16).padStart(40, "0")}` as TransferTx["sender"],
    receiver: `ZYN${(index + 10_000).toString(16).padStart(40, "0")}` as TransferTx["receiver"],
    amountAtoms: 1,
    feeAtoms,
    timestampMs: 1_700_100_000_000 + index,
    publicKey: "11".repeat(64),
    signature: "22".repeat(64),
    txid: index.toString(16).padStart(64, "0")
  };
}

test("saturated mempool reuses eviction scan until contents mutate", () => {
  const mempool = new Mempool(3, 0);
  mempool.add(transfer(1, 1));
  mempool.add(transfer(2, 2));
  mempool.add(transfer(3, 3));

  const internal = mempool as unknown as {
    computeLowestPriorityEvictableTransfer(): { txid: string; tx: Transaction } | undefined;
  };
  const original = internal.computeLowestPriorityEvictableTransfer.bind(mempool);
  let scans = 0;
  internal.computeLowestPriorityEvictableTransfer = () => {
    scans += 1;
    return original();
  };

  assert.throws(() => mempool.add(transfer(100, 1)), /Mempool full/);
  assert.equal(scans, 1);

  assert.throws(() => mempool.add(transfer(101, 1)), /Mempool full/);
  assert.throws(() => mempool.add(transfer(102, 1)), /Mempool full/);
  assert.equal(scans, 1, "unchanged full pool must not be rescanned for repeated rejected admissions");

  const stronger = transfer(103, 100);
  mempool.add(stronger);
  assert.equal(scans, 1, "successful admission may reuse the candidate computed for the unchanged full pool");
  assert.ok(mempool.values().some((tx) => tx.txid === stronger.txid));
  assert.ok(!mempool.values().some((tx) => tx.txid === transfer(1, 1).txid));

  assert.throws(() => mempool.add(transfer(104, 1)), /Mempool full/);
  assert.equal(scans, 2, "successful mutation must invalidate the eviction cache");
});
