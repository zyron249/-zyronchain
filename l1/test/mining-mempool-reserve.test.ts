import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/codec.js";
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

function transferReplacement(existing: TransferTx): TransferTx {
  return {
    ...existing,
    feeAtoms: existing.feeAtoms + 10,
    timestampMs: existing.timestampMs + 1,
    signature: "55".repeat(64),
    txid: "ef".repeat(32)
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

function strongerMiningReplacement(existing: MiningClaimTx): MiningClaimTx {
  return {
    ...existing,
    height: existing.height + 1,
    previousHash: "cd".repeat(32),
    workNonce: "ff".repeat(8),
    timestampMs: existing.timestampMs + 1,
    signature: "66".repeat(64),
    txid: "fe".repeat(32)
  };
}

function txBytes(tx: TransferTx | MiningClaimTx): number {
  return Buffer.byteLength(canonicalJson(tx), "utf8");
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

test("occupancy accounting stays exact across remove prune and same-nonce replacements", () => {
  const mempool = new Mempool(2, 1);
  const first = transfer(1);
  const second = transfer(2);
  const initialClaim = miningClaim(1);
  mempool.add(first);
  mempool.add(second);
  mempool.add(initialClaim);

  mempool.remove([first.txid]);
  const third = transfer(3);
  mempool.add(third);
  assert.equal(mempool.prune((tx) => tx.txid === second.txid), 1);
  const fourth = transfer(4);
  mempool.add(fourth);

  const replacement = transferReplacement(third);
  mempool.add(replacement);
  const claimReplacement = strongerMiningReplacement(initialClaim);
  mempool.add(claimReplacement);

  assert.equal(mempool.size, 3);
  const values = mempool.values();
  assert.deepEqual(
    new Set(values.filter((tx) => tx.kind !== "mining_claim").map((tx) => tx.txid)),
    new Set([replacement.txid, fourth.txid])
  );
  assert.deepEqual(
    values.filter((tx) => tx.kind === "mining_claim").map((tx) => tx.txid),
    [claimReplacement.txid]
  );

  assert.throws(() => mempool.add(transfer(5)), /Mempool full/);
  const strongerIndependentClaim = { ...miningClaim(9), height: claimReplacement.height + 1 };
  mempool.add(strongerIndependentClaim);
  assert.equal(mempool.size, 3);
  assert.equal(mempool.values().filter((tx) => tx.kind === "mining_claim").length, 1);
  assert.ok(mempool.values().some((tx) => tx.txid === strongerIndependentClaim.txid));
});

test("non-mining retained bytes fail closed before the entry-count cap", () => {
  const first = transfer(1);
  const second = transfer(2);
  const byteBudget = txBytes(first) + txBytes(second) - 1;
  const mempool = new Mempool(10, 0, byteBudget, 1024 * 1024);

  mempool.add(first);
  assert.throws(() => mempool.add(second), /Mempool full/);
  assert.equal(mempool.size, 1);
  assert.equal(mempool.values()[0]?.txid, first.txid);
});

test("byte pressure never cascades through multiple ordinary evictions for one incoming transaction", () => {
  const first = transfer(1);
  const second = transfer(2);
  const incoming = { ...transfer(3), feeAtoms: 1_000_000_000_000 };
  const byteBudget = txBytes(first) + txBytes(second);
  const mempool = new Mempool(10, 0, byteBudget, 1024 * 1024);

  mempool.add(first);
  mempool.add(second);
  assert.ok(txBytes(second) + txBytes(incoming) > byteBudget);
  assert.throws(() => mempool.add(incoming), /Mempool full/);
  assert.deepEqual(new Set(mempool.values().map((tx) => tx.txid)), new Set([first.txid, second.txid]));
});

test("non-mining byte accounting is released by removal and stays exact across replacement", () => {
  const first = transfer(1);
  const second = transfer(2);
  const replacement = transferReplacement(second);
  const byteBudget = Math.max(txBytes(first), txBytes(second), txBytes(replacement));
  const mempool = new Mempool(10, 0, byteBudget, 1024 * 1024);

  mempool.add(first);
  mempool.remove([first.txid]);
  mempool.add(second);
  mempool.add(replacement);

  assert.equal(mempool.size, 1);
  assert.equal(mempool.values()[0]?.txid, replacement.txid);
});

test("mining retained-byte reserve is isolated from saturated non-mining bytes", () => {
  const normal = transfer(1);
  const firstClaim = miningClaim(1);
  const strongerClaim = { ...miningClaim(2), height: firstClaim.height + 1 };
  const mempool = new Mempool(10, 2, txBytes(normal), txBytes(firstClaim));

  mempool.add(normal);
  assert.throws(() => mempool.add(transfer(2)), /Mempool full/);

  mempool.add(firstClaim);
  mempool.add(strongerClaim);

  const values = mempool.values();
  assert.equal(values.filter((tx) => tx.kind !== "mining_claim").length, 1);
  assert.deepEqual(values.filter((tx) => tx.kind === "mining_claim").map((tx) => tx.txid), [strongerClaim.txid]);
});
