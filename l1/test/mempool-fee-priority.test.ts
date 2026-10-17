import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/codec.js";
import { orderPendingByFeePriority, ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createTransfer } from "../src/transaction.js";
import type { GenesisConfig, Transaction } from "../src/types.js";

// External reviewer note EXT-01: selection used to be ordered by sender
// address, so lexicographically small addresses always won regardless of fee.

const key = (n: number): string => n.toString(16).padStart(64, "0");
const validatorPrivate = key(1);
const oraclePublic = publicKeyFromPrivate(key(4));
const activityPool = addressFromPublicKey(publicKeyFromPrivate(key(6)));
const accounts = [key(3), key(5), key(9), key(10)].map((privateKey) => {
  const publicKey = publicKeyFromPrivate(privateKey);
  return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
}).sort((a, b) => (a.address < b.address ? -1 : 1));
const low = accounts[0]!; // lexicographically smallest address
const high = accounts[accounts.length - 1]!; // largest address

function genesis(): GenesisConfig {
  const validatorPublic = publicKeyFromPrivate(validatorPrivate);
  return {
    chainId: "zyron-devnet-1",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [
      ...accounts.map((account) => ({ address: account.address, amountAtoms: 1_000_000_000 })),
      { address: activityPool, amountAtoms: 5_000_000_000 }
    ]
  };
}

function transfer(from: typeof low, nonce: number, feeAtoms: number, timestampMs = 100): Transaction {
  return createTransfer(
    { chainId: genesis().chainId, nonce, sender: from.address, receiver: accounts[1]!.address, amountAtoms: 1, feeAtoms, timestampMs },
    from.privateKey,
    from.publicKey
  );
}

test("higher fee wins across senders regardless of address order", () => {
  const chain = new ZyronChain(genesis());
  const cheap = transfer(low, 1, 1);
  const rich = transfer(high, 1, 50);
  assert.deepEqual(chain.selectValidPending([cheap, rich], 10).map((tx) => tx.txid), [rich.txid, cheap.txid]);
  const budget = Buffer.byteLength(canonicalJson(rich), "utf8");
  assert.deepEqual(chain.selectValidPending([cheap, rich], 10, budget).map((tx) => tx.txid), [rich.txid]);
  assert.deepEqual(chain.selectValidPending([cheap, rich], 1).map((tx) => tx.txid), [rich.txid]);
});

test("per-sender nonce order is preserved while interleaving by fee", () => {
  const chain = new ZyronChain(genesis());
  const a1 = transfer(low, 1, 1);
  const a2 = transfer(low, 2, 100);
  const b1 = transfer(high, 1, 10);
  assert.deepEqual(chain.selectValidPending([a2, b1, a1], 10).map((tx) => tx.txid), [b1.txid, a1.txid, a2.txid]);
});

test("ordering is deterministic for any input permutation", () => {
  const txs = [transfer(low, 1, 5), transfer(low, 2, 5), transfer(high, 1, 5, 99), transfer(accounts[1]!, 1, 5, 99), transfer(accounts[2]!, 1, 7)];
  const expected = orderPendingByFeePriority(txs).map((tx) => tx.txid);
  for (let i = 0; i < 20; i += 1) {
    const shuffled = [...txs].sort(() => Math.random() - 0.5);
    assert.deepEqual(orderPendingByFeePriority(shuffled).map((tx) => tx.txid), expected);
  }
  assert.equal(expected[0], txs[4]!.txid, "highest fee first");
});

test("zero-fee protocol transactions are not starved by fee-paying transfers", () => {
  const richTransfer = transfer(low, 1, 1_000);
  const settlement = { ...transfer(high, 1, 0), kind: "activity_settlement" } as unknown as Transaction;
  assert.deepEqual(orderPendingByFeePriority([richTransfer, settlement]).map((tx) => tx.kind), ["activity_settlement", "transfer"]);
});

test("same sender and nonce alternatives: higher fee is tried first", () => {
  const chain = new ZyronChain(genesis());
  const first = transfer(low, 1, 1);
  const bump = transfer(low, 1, 9, 101);
  assert.deepEqual(chain.selectValidPending([first, bump], 10).map((tx) => tx.txid), [bump.txid]);
});
