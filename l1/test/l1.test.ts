import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { Mempool } from "../src/mempool.js";
import { ZyronChain } from "../src/chain.js";
import { createActivitySettlement, createTransfer } from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

const validatorOnePrivate = "01".padStart(64, "0");
const validatorTwoPrivate = "02".padStart(64, "0");
const alicePrivate = "03".padStart(64, "0");
const oraclePrivate = "04".padStart(64, "0");

const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const alicePublic = publicKeyFromPrivate(alicePrivate);
const oraclePublic = publicKeyFromPrivate(oraclePrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);
const alice = addressFromPublicKey(alicePublic);
const bob = addressFromPublicKey(publicKeyFromPrivate("05".padStart(64, "0")));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("06".padStart(64, "0")));

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-devnet-1",
    timestampMs: 1_700_000_000_000,
    validators: [
      { address: validatorOne, publicKey: validatorOnePublic },
      { address: validatorTwo, publicKey: validatorTwoPublic }
    ],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [
      { address: alice, amountAtoms: 1_000_000_000 },
      { address: activityPool, amountAtoms: 5_000_000_000 }
    ]
  };
}

test("PoA validators rotate and independently reproduce state", () => {
  const producer = new ZyronChain(genesis());
  const follower = new ZyronChain(genesis());
  const tx = createTransfer(
    {
      chainId: genesis().chainId,
      nonce: 1,
      sender: alice,
      receiver: bob,
      amountAtoms: 250_000_000,
      feeAtoms: 1_000,
      timestampMs: 1_700_000_000_100
    },
    alicePrivate,
    alicePublic
  );

  let blockOne = producer.produceBlock([tx], validatorOnePrivate, {
    timestampMs: 1_700_000_000_200
  });
  blockOne = producer.attestBlock(blockOne, validatorOnePrivate);
  blockOne = producer.attestBlock(blockOne, validatorTwoPrivate);
  producer.acceptBlock(blockOne, 1_700_000_000_200);
  follower.acceptBlock(blockOne, 1_700_000_000_200);

  let blockTwo = producer.produceBlock([], validatorTwoPrivate, {
    timestampMs: 1_700_000_000_300
  });
  blockTwo = producer.attestBlock(blockTwo, validatorOnePrivate);
  blockTwo = producer.attestBlock(blockTwo, validatorTwoPrivate);
  producer.acceptBlock(blockTwo, 1_700_000_000_300);
  follower.acceptBlock(blockTwo, 1_700_000_000_300);

  assert.equal(producer.height, 2);
  assert.equal(follower.tip.hash, producer.tip.hash);
  assert.equal(follower.getState().root(), producer.getState().root());
  assert.equal(producer.getState().balance(bob), 250_000_000);
  assert.equal(producer.getState().nonce(alice), 1);
});

test("wrong PoA proposer cannot create the scheduled block", () => {
  const chain = new ZyronChain(genesis());
  assert.throws(
    () => chain.produceBlock([], validatorTwoPrivate, { timestampMs: 1_700_000_000_100 }),
    /expected proposer/
  );
});

test("state root detects transaction/state tampering", () => {
  const chain = new ZyronChain(genesis());
  const block = chain.produceBlock([], validatorOnePrivate, {
    timestampMs: 1_700_000_000_100
  });
  block.header.stateRoot = "f".repeat(64);
  assert.throws(() => chain.acceptBlock(block, 1_700_000_000_100), /Block hash mismatch/);
});

test("activity settlement debits a finite pool and cannot replay an epoch", () => {
  const chain = new ZyronChain(genesis());
  const settlement = createActivitySettlement(
    {
      chainId: genesis().chainId,
      nonce: 1,
      sender: activityPool,
      epoch: 7,
      entries: [
        { receiver: bob, amountAtoms: 10_000_000 },
        { receiver: alice, amountAtoms: 20_000_000 }
      ],
      receiptRoot: sha256Hex("activity-epoch-7"),
      timestampMs: 1_700_000_000_100
    },
    oraclePrivate,
    oraclePublic
  );
  let block = chain.produceBlock([settlement], validatorOnePrivate, {
    timestampMs: 1_700_000_000_200
  });
  block = chain.attestBlock(block, validatorOnePrivate);
  block = chain.attestBlock(block, validatorTwoPrivate);
  chain.acceptBlock(block, 1_700_000_000_200);

  assert.equal(chain.getState().balance(bob), 10_000_000);
  assert.equal(chain.getState().balance(activityPool), 4_970_000_000);

  const replayWithNextNonce = createActivitySettlement(
    { ...settlement, nonce: 2 },
    oraclePrivate,
    oraclePublic
  );
  assert.throws(
    () => chain.produceBlock([replayWithNextNonce], validatorTwoPrivate, {
      timestampMs: 1_700_000_000_300
    }),
    /already settled/
  );
});

test("unauthorized activity oracle is rejected", () => {
  const chain = new ZyronChain(genesis());
  const settlement = createActivitySettlement(
    {
      chainId: genesis().chainId,
      nonce: 1,
      sender: activityPool,
      epoch: 1,
      entries: [{ receiver: bob, amountAtoms: 1 }],
      receiptRoot: sha256Hex("x"),
      timestampMs: 1_700_000_000_100
    },
    alicePrivate,
    alicePublic
  );
  assert.throws(
    () => chain.produceBlock([settlement], validatorOnePrivate, {
      timestampMs: 1_700_000_000_200
    }),
    /Unauthorized activity oracle/
  );
});

test("block finality requires a greater-than-two-thirds validator quorum", () => {
  const chain = new ZyronChain(genesis());
  let block = chain.produceBlock([], validatorOnePrivate, {
    timestampMs: 1_700_000_000_100
  });
  block = chain.attestBlock(block, validatorOnePrivate);
  assert.throws(
    () => chain.acceptBlock(block, 1_700_000_000_100),
    /Finality quorum not reached/
  );
  block = chain.attestBlock(block, validatorTwoPrivate);
  chain.acceptBlock(block, 1_700_000_000_100);
  assert.equal(chain.height, 1);
});

test("mempool blocks duplicate sender nonces and orders by fee", () => {
  const first = createTransfer(
    {
      chainId: genesis().chainId,
      nonce: 1,
      sender: alice,
      receiver: bob,
      amountAtoms: 1,
      feeAtoms: 10,
      timestampMs: 100
    },
    alicePrivate,
    alicePublic
  );
  const conflict = createTransfer(
    {
      chainId: genesis().chainId,
      nonce: 1,
      sender: alice,
      receiver: validatorOne,
      amountAtoms: 1,
      feeAtoms: 20,
      timestampMs: 101
    },
    alicePrivate,
    alicePublic
  );
  const pool = new Mempool();
  pool.add(first);
  assert.throws(() => pool.add(conflict), /Conflicting sender nonce/);
  assert.equal(pool.select(10)[0]?.txid, first.txid);
});
