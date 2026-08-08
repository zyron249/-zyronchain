import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { Mempool } from "../src/mempool.js";
import { ZyronChain } from "../src/chain.js";
import {
  createActivitySettlement,
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer,
  createValidatorApproval,
  createValidatorSetUpdate
} from "../src/transaction.js";
import { createRoundSkipVote, validateBlockShape } from "../src/block.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import { createRpcServer, NodeService, PeerClient, produceFinalizedBlock } from "../src/node.js";
import type { GenesisConfig } from "../src/types.js";

const validatorOnePrivate = "01".padStart(64, "0");
const validatorTwoPrivate = "02".padStart(64, "0");
const alicePrivate = "03".padStart(64, "0");
const oraclePrivate = "04".padStart(64, "0");
const newValidatorOnePrivate = "07".padStart(64, "0");
const newValidatorTwoPrivate = "08".padStart(64, "0");

const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const alicePublic = publicKeyFromPrivate(alicePrivate);
const oraclePublic = publicKeyFromPrivate(oraclePrivate);
const newValidatorOnePublic = publicKeyFromPrivate(newValidatorOnePrivate);
const newValidatorTwoPublic = publicKeyFromPrivate(newValidatorTwoPrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);
const alice = addressFromPublicKey(alicePublic);
const bob = addressFromPublicKey(publicKeyFromPrivate("05".padStart(64, "0")));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("06".padStart(64, "0")));
const newValidatorOne = addressFromPublicKey(newValidatorOnePublic);
const newValidatorTwo = addressFromPublicKey(newValidatorTwoPublic);

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

test("uncertified nonzero consensus rounds are rejected for safety", () => {
  const chain = new ZyronChain(genesis());
  assert.throws(
    () => chain.produceBlock([], validatorTwoPrivate, {
      round: 1,
      timestampMs: 1_700_000_000_100
    }),
    /skip quorum/
  );
});

test("a greater-than-two-thirds skip certificate safely unlocks the next proposer round", () => {
  const chain = new ZyronChain(genesis());
  const voteOne = createRoundSkipVote({
    chainId: genesis().chainId,
    height: 1,
    round: 0,
    previousHash: chain.tip.hash,
    validatorPrivateKey: validatorOnePrivate,
    validatorPublicKey: validatorOnePublic
  });
  const voteTwo = createRoundSkipVote({
    chainId: genesis().chainId,
    height: 1,
    round: 0,
    previousHash: chain.tip.hash,
    validatorPrivateKey: validatorTwoPrivate,
    validatorPublicKey: validatorTwoPublic
  });
  const proposal = chain.produceBlock([], validatorTwoPrivate, {
    round: 1,
    timestampMs: 1_700_000_000_100,
    roundCertificate: [voteOne, voteTwo]
  });
  assert.doesNotThrow(() => chain.validateProposal(proposal, 1_700_000_000_100));
});

test("mempool blocks same-nonce replacements without a material fee-rate bump", () => {
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
      feeAtoms: 10,
      timestampMs: 101
    },
    alicePrivate,
    alicePublic
  );
  const pool = new Mempool();
  pool.add(first);
  assert.throws(() => pool.add(conflict), /Conflicting sender nonce/);
  assert.equal(pool.values()[0]?.txid, first.txid);
});

test("mempool replaces same-nonce transfers after a material fee-rate bump", () => {
  const first = createTransfer(
    { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 10, timestampMs: 100 },
    alicePrivate,
    alicePublic
  );
  const replacement = createTransfer(
    { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 20, timestampMs: 101 },
    alicePrivate,
    alicePublic
  );
  const pool = new Mempool();
  pool.add(first);
  pool.add(replacement);
  assert.equal(pool.size, 1);
  assert.equal(pool.values()[0]?.txid, replacement.txid);
  assert.equal(pool.pendingTransferSpend(alice), 21n);
});

test("full mempool evicts only a sender tail for a materially better fee rate", () => {
  const bobPrivate = "05".padStart(64, "0");
  const bobPublic = publicKeyFromPrivate(bobPrivate);
  const activityPrivate = "06".padStart(64, "0");
  const activityPublic = publicKeyFromPrivate(activityPrivate);
  const low = createTransfer(
    { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 10, timestampMs: 100 },
    alicePrivate,
    alicePublic
  );
  const medium = createTransfer(
    { chainId: genesis().chainId, nonce: 1, sender: bob, receiver: alice, amountAtoms: 1, feeAtoms: 20, timestampMs: 101 },
    bobPrivate,
    bobPublic
  );
  const high = createTransfer(
    { chainId: genesis().chainId, nonce: 1, sender: activityPool, receiver: alice, amountAtoms: 1, feeAtoms: 100, timestampMs: 102 },
    activityPrivate,
    activityPublic
  );
  const pool = new Mempool(2);
  pool.add(low);
  pool.add(medium);
  pool.add(high);
  const txids = new Set(pool.values().map((tx) => tx.txid));
  assert.equal(pool.size, 2);
  assert.equal(txids.has(low.txid), false);
  assert.equal(txids.has(medium.txid), true);
  assert.equal(txids.has(high.txid), true);
});

test("wire schemas reject unknown transaction and block fields", () => {
  const tx = createTransfer(
    {
      chainId: genesis().chainId,
      nonce: 1,
      sender: alice,
      receiver: bob,
      amountAtoms: 1,
      feeAtoms: 1,
      timestampMs: 100
    },
    alicePrivate,
    alicePublic
  );
  const chain = new ZyronChain(genesis());
  assert.throws(() => chain.validatePending([{ ...tx, injected: true } as never]), /fields/);

  const block = chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
  assert.throws(() => validateBlockShape({ ...block, debug: "smuggled" }), /fields/);
  assert.throws(
    () => validateBlockShape({ ...block, header: { ...block.header, futureRule: 1 } }),
    /fields/
  );
});

test("mempool selection restores sender nonce order even when later nonce pays more", () => {
  const chain = new ZyronChain(genesis());
  const nonceOne = createTransfer(
    { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 1, timestampMs: 100 },
    alicePrivate,
    alicePublic
  );
  const nonceTwo = createTransfer(
    { chainId: genesis().chainId, nonce: 2, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 100, timestampMs: 101 },
    alicePrivate,
    alicePublic
  );
  const pool = new Mempool();
  pool.add(nonceTwo);
  pool.add(nonceOne);
  assert.deepEqual(chain.selectValidPending(pool.values(), 10).map((tx) => tx.nonce), [1, 2]);
});

test("block assembly respects a transaction byte budget without breaking nonce order", () => {
  const chain = new ZyronChain(genesis());
  const nonceOne = createTransfer(
    { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 1, timestampMs: 100 },
    alicePrivate,
    alicePublic
  );
  const nonceTwo = createTransfer(
    { chainId: genesis().chainId, nonce: 2, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 1, timestampMs: 101 },
    alicePrivate,
    alicePublic
  );
  const oneTransactionBudget = Buffer.byteLength(canonicalJson(nonceOne), "utf8");
  const selected = chain.selectValidPending([nonceTwo, nonceOne], 10, oneTransactionBudget);
  assert.deepEqual(selected.map((tx) => tx.nonce), [1]);
  const block = chain.produceBlock(selected, validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
  assert.equal(block.transactions.length, 1);
});

test("finalized conflicting nonce prunes stale mempool entries instead of leaking capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-mempool-prune-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    const service = new NodeService(store);
    const pending = createTransfer(
      { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 10, timestampMs: 100 },
      alicePrivate,
      alicePublic
    );
    const finalizedTx = createTransfer(
      { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 2, feeAtoms: 1, timestampMs: 101 },
      alicePrivate,
      alicePublic
    );
    service.submitTransaction(pending);
    assert.equal(service.mempool.size, 1);

    let block = store.chain.produceBlock([finalizedTx], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    await service.acceptFinalizedBlock(block);
    assert.equal(service.mempool.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("node read and mempool hot paths do not clone the full ledger state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-node-hot-path-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    const service = new NodeService(store);
    store.chain.getState = () => {
      throw new Error("full state clone reached node hot path");
    };

    assert.equal(service.balance(alice), 1_000_000_000);
    assert.equal(service.nonce(alice), 0);
    const pending = createTransfer(
      { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 1, timestampMs: 100 },
      alicePrivate,
      alicePublic
    );
    assert.equal(service.submitTransaction(pending), pending.txid);

    let block = store.chain.produceBlock([pending], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    await service.acceptFinalizedBlock(block);
    assert.equal(service.mempool.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("future-nonce mempool admission rejects unaffordable and unauthorized spam", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-mempool-admission-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    const service = new NodeService(store);
    const bobPrivate = "05".padStart(64, "0");
    const bobPublic = publicKeyFromPrivate(bobPrivate);
    const unfunded = createTransfer(
      { chainId: genesis().chainId, nonce: 2, sender: bob, receiver: alice, amountAtoms: 1, feeAtoms: 0, timestampMs: 100 },
      bobPrivate,
      bobPublic
    );
    assert.throws(() => service.submitTransaction(unfunded), /Insufficient balance/);

    const firstReserved = createTransfer(
      { chainId: genesis().chainId, nonce: 2, sender: alice, receiver: bob, amountAtoms: 600_000_000, feeAtoms: 0, timestampMs: 101 },
      alicePrivate,
      alicePublic
    );
    const oversubscribed = createTransfer(
      { chainId: genesis().chainId, nonce: 3, sender: alice, receiver: bob, amountAtoms: 600_000_000, feeAtoms: 0, timestampMs: 102 },
      alicePrivate,
      alicePublic
    );
    service.submitTransaction(firstReserved);
    assert.throws(() => service.submitTransaction(oversubscribed), /Pending transfers exceed confirmed balance/);
    assert.equal(service.mempool.pendingTransferSpend(alice), 600_000_000n);

    const validatorProposal = {
      chainId: genesis().chainId,
      nonce: 3,
      sender: alice,
      activationHeight: 200,
      validators: genesis().validators
    };
    const unauthorizedGovernance = createValidatorSetUpdate(
      {
        ...validatorProposal,
        approvals: [
          createValidatorApproval(validatorProposal, validatorOnePrivate, validatorOnePublic),
          createValidatorApproval(validatorProposal, validatorTwoPrivate, validatorTwoPublic)
        ],
        timestampMs: 103
      },
      alicePrivate,
      alicePublic
    );
    assert.throws(() => service.submitTransaction(unauthorizedGovernance), /initiator is not active/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("node replacement accounting releases the replaced transfer obligation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-mempool-rbf-"));
  try {
    const service = new NodeService(await ChainStore.open(genesis(), directory));
    const first = createTransfer(
      { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 900_000_000, feeAtoms: 10, timestampMs: 100 },
      alicePrivate,
      alicePublic
    );
    const replacement = createTransfer(
      { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 900_000_000, feeAtoms: 20, timestampMs: 101 },
      alicePrivate,
      alicePublic
    );
    service.submitTransaction(first);
    assert.doesNotThrow(() => service.submitTransaction(replacement));
    assert.equal(service.mempool.size, 1);
    assert.equal(service.mempool.values()[0]?.txid, replacement.txid);
    assert.equal(service.mempool.pendingTransferSpend(alice), 900_000_020n);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("chain store replays finalized blocks and pins the genesis identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-store-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    let block = store.chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
    await assert.rejects(
      () => store.commitFinalizedBlock(block, 1_700_000_000_100),
      /Finality quorum not reached/
    );
    assert.equal(store.chain.height, 0);
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    await store.commitFinalizedBlock(block, 1_700_000_000_100);

    const reopened = await ChainStore.open(genesis(), directory);
    assert.equal(reopened.chain.height, 1);
    assert.equal(reopened.chain.tip.hash, block.hash);
    assert.equal(reopened.chain.getState().root(), store.chain.getState().root());

    const different = genesis();
    different.timestampMs += 1;
    await assert.rejects(() => ChainStore.open(different, directory), /different or unsupported chain/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint snapshot is deterministic across restart and binds finalized state schedules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-snapshot-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    let block = store.chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    await store.commitFinalizedBlock(block, 1_700_000_000_100);
    const first = await store.writeSnapshot(join(directory, "checkpoint-a.json"));

    const reopened = await ChainStore.open(genesis(), directory);
    const second = await reopened.writeSnapshot(join(directory, "checkpoint-b.json"));
    assert.equal(second.sha256, first.sha256);
    assert.equal(second.height, 1);

    const snapshot = JSON.parse(await readFile(join(directory, "checkpoint-b.json"), "utf8")) as Record<string, unknown>;
    assert.equal(snapshot.genesisHash, reopened.chain.genesisHash);
    assert.equal(snapshot.height, reopened.chain.height);
    assert.deepEqual(snapshot.tip, reopened.chain.tip);
    assert.ok(Array.isArray(snapshot.validatorSchedule));
    assert.ok(Array.isArray(snapshot.protocolSchedule));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repeated crash-style reopen preserves tip and state across a 100-block replay soak", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-replay-soak-"));
  try {
    let store = await ChainStore.open(genesis(), directory);
    for (let height = 1; height <= 100; height += 1) {
      const tx = createTransfer(
        {
          chainId: genesis().chainId,
          nonce: height,
          sender: alice,
          receiver: bob,
          amountAtoms: 1,
          feeAtoms: 0,
          timestampMs: genesis().timestampMs + (height * 100) - 1
        },
        alicePrivate,
        alicePublic
      );
      const proposerKey = height % 2 === 1 ? validatorOnePrivate : validatorTwoPrivate;
      let block = store.chain.produceBlock([tx], proposerKey, { timestampMs: genesis().timestampMs + (height * 100) });
      block = store.chain.attestBlock(block, validatorOnePrivate);
      block = store.chain.attestBlock(block, validatorTwoPrivate);
      await store.commitFinalizedBlock(block, genesis().timestampMs + (height * 100));
      if (height % 10 === 0) {
        const tip = store.chain.tip.hash;
        const root = store.chain.getState().root();
        store = await ChainStore.open(genesis(), directory);
        assert.equal(store.chain.height, height);
        assert.equal(store.chain.tip.hash, tip);
        assert.equal(store.chain.getState().root(), root);
      }
    }
    assert.equal(store.chain.getState().balance(bob), 100);
    assert.equal(store.chain.getState().nonce(alice), 100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("signing journal prevents validator double-sign across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-signing-"));
  try {
    const first = await SigningJournal.open(directory);
    await first.reserveAttestation(8, 0, "a".repeat(64));
    await first.reserveAttestation(8, 0, "a".repeat(64));
    const reopened = await SigningJournal.open(directory);
    await assert.rejects(() => reopened.reserveAttestation(8, 0, "b".repeat(64)), /Conflicting validator action/);
    await assert.rejects(() => reopened.reserveSkip(8, 0, "c".repeat(64)), /Conflicting validator action/);
    await reopened.reserveAttestation(8, 1, "d".repeat(64));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two node services attest a proposal, finalize it, persist it, and converge", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-node-a-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-node-b-"));
  try {
    const firstStore = await ChainStore.open(genesis(), firstDir);
    const secondStore = await ChainStore.open(genesis(), secondDir);
    const first = new NodeService(firstStore, await SigningJournal.open(firstDir), validatorOnePrivate);
    const second = new NodeService(secondStore, await SigningJournal.open(secondDir), validatorTwoPrivate);
    const proposal = firstStore.chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
    const attestationOne = await first.attestProposal(proposal);
    const attestationTwo = await second.attestProposal(proposal);
    const finalized = { ...proposal, attestations: [attestationOne, attestationTwo] };
    await first.acceptFinalizedBlock(finalized);
    await second.acceptFinalizedBlock(finalized);
    assert.equal(first.status().height, 1);
    assert.equal(second.status().tipHash, first.status().tipHash);

    const reopened = await ChainStore.open(genesis(), secondDir);
    assert.equal(reopened.chain.tip.hash, finalized.hash);
  } finally {
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});

test("HTTP RPC exposes status and accepts a strictly validated signed transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-rpc-"));
  const store = await ChainStore.open(genesis(), directory);
  const service = new NodeService(store);
  const server = createRpcServer(service);
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("RPC test server has no TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    const status = await (await fetch(`${base}/status`)).json() as { chainId: string; height: number };
    assert.equal(status.chainId, genesis().chainId);
    assert.equal(status.height, 0);

    const tx = createTransfer(
      { chainId: genesis().chainId, nonce: 1, sender: alice, receiver: bob, amountAtoms: 1, feeAtoms: 1, timestampMs: 100 },
      alicePrivate,
      alicePublic
    );
    const response = await fetch(`${base}/tx`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tx)
    });
    assert.equal(response.status, 202);
    assert.equal(service.mempool.size, 1);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC exposes health and metrics while enforcing per-client request limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-rpc-limit-"));
  const store = await ChainStore.open(genesis(), directory);
  const service = new NodeService(store);
  const server = createRpcServer(service, { requestsPerWindow: 2, windowMs: 60_000, maxConnections: 8 });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("RPC test server has no TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, height: 0 });
    assert.equal(health.headers.get("x-ratelimit-limit"), "2");

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    const payload = await metrics.json() as Record<string, unknown>;
    assert.equal(payload.chainId, genesis().chainId);
    assert.equal(payload.height, 0);
    assert.equal(payload.mempoolSize, 0);
    assert.equal(payload.validatorCount, 2);
    assert.equal(typeof payload.uptimeSeconds, "number");

    const limited = await fetch(`${base}/status`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC peer authentication protects consensus writes without hiding public status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-rpc-auth-"));
  const store = await ChainStore.open(genesis(), directory);
  const service = new NodeService(store);
  const token = "peer-test-token-0123456789abcdef";
  const server = createRpcServer(service, { peerAuthToken: token });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("RPC auth test server has no TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    assert.equal((await fetch(`${base}/status`)).status, 200);
    const denied = await fetch(`${base}/block`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("www-authenticate"), "Bearer");

    const wrong = await fetch(`${base}/round/skip`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${"x".repeat(token.length)}` },
      body: "{}"
    });
    assert.equal(wrong.status, 401);

    const authenticated = await fetch(`${base}/block`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}"
    });
    assert.equal(authenticated.status, 400);
    assert.notEqual((await authenticated.json() as { error?: string }).error, "Peer authentication required");
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer authentication credentials cannot be sent to remote plaintext HTTP peers", () => {
  const token = "peer-test-token-0123456789abcdef";
  assert.throws(
    () => new PeerClient(["http://validator.example:9137"], token),
    /Authenticated remote peers must use HTTPS/
  );
  assert.deepEqual(
    new PeerClient(["https://validator.example:9137"], token).peers,
    ["https://validator.example:9137"]
  );
  assert.deepEqual(
    new PeerClient(["http://127.0.0.1:9137"], token).peers,
    ["http://127.0.0.1:9137"]
  );
});

test("peer sync handshakes on chain identity and incrementally replays finalized blocks", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "zyron-sync-source-"));
  const targetDir = await mkdtemp(join(tmpdir(), "zyron-sync-target-"));
  const sourceStore = await ChainStore.open(genesis(), sourceDir);
  const source = new NodeService(sourceStore);
  const server = createRpcServer(source);
  try {
    let block = sourceStore.chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
    block = sourceStore.chain.attestBlock(block, validatorOnePrivate);
    block = sourceStore.chain.attestBlock(block, validatorTwoPrivate);
    await source.acceptFinalizedBlock(block);

    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Sync test server has no TCP address");
    const peerUrl = `http://127.0.0.1:${address.port}`;
    const targetStore = await ChainStore.open(genesis(), targetDir);
    const target = new NodeService(targetStore);
    const accepted = await new PeerClient([peerUrl]).syncFrom(peerUrl, target);
    assert.equal(accepted, 1);
    assert.equal(target.status().height, 1);
    assert.equal(target.status().tipHash, source.status().tipHash);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("any-peer sync ignores a wrong-chain candidate and converges from an honest peer", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "zyron-any-source-"));
  const targetDir = await mkdtemp(join(tmpdir(), "zyron-any-target-"));
  const wrongDir = await mkdtemp(join(tmpdir(), "zyron-any-wrong-"));
  const servers: ReturnType<typeof createRpcServer>[] = [];
  try {
    const sourceStore = await ChainStore.open(genesis(), sourceDir);
    const source = new NodeService(sourceStore);
    let block = sourceStore.chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
    block = sourceStore.chain.attestBlock(block, validatorOnePrivate);
    block = sourceStore.chain.attestBlock(block, validatorTwoPrivate);
    await source.acceptFinalizedBlock(block);

    const wrongGenesis = genesis();
    wrongGenesis.chainId = "zyron-hostile-1";
    const wrong = new NodeService(await ChainStore.open(wrongGenesis, wrongDir));
    for (const service of [wrong, source]) {
      const server = createRpcServer(service);
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolveListen());
      });
      servers.push(server);
    }
    const urls = servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Any-peer test server has no TCP address");
      return `http://127.0.0.1:${address.port}`;
    });
    const target = new NodeService(await ChainStore.open(genesis(), targetDir));
    const accepted = await new PeerClient(urls).syncAny(target);
    assert.equal(accepted, 1);
    assert.equal(target.status().tipHash, source.status().tipHash);
  } finally {
    for (const server of servers) {
      if (server.listening) {
        await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      }
    }
    await Promise.all([sourceDir, targetDir, wrongDir].map((directory) => rm(directory, { recursive: true, force: true })));
  }
});

test("sync serving adapts block count to a byte budget instead of emitting an oversized batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-sync-budget-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    const service = new NodeService(store);
    const finalized: ReturnType<ZyronChain["produceBlock"]>[] = [];
    for (let height = 1; height <= 3; height += 1) {
      const proposerKey = height % 2 === 1 ? validatorOnePrivate : validatorTwoPrivate;
      let block = store.chain.produceBlock([], proposerKey, { timestampMs: genesis().timestampMs + (height * 100) });
      block = store.chain.attestBlock(block, validatorOnePrivate);
      block = store.chain.attestBlock(block, validatorTwoPrivate);
      await service.acceptFinalizedBlock(block);
      finalized.push(block);
    }
    const oneBlockBudget = Buffer.byteLength('{"blocks":[]}', "utf8") +
      Buffer.byteLength(JSON.stringify(finalized[0]!), "utf8") + 1;
    const firstBatch = await service.blocks(1, 100, oneBlockBudget);
    assert.equal(firstBatch.length, 1);
    assert.equal(firstBatch[0]!.header.height, 1);
    const secondBatch = await service.blocks(2, 100, oneBlockBudget);
    assert.equal(secondBatch.length, 1);
    assert.equal(secondBatch[0]!.header.height, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("certified view-change recovers liveness after a proposer misses its round", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-view-a-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-view-b-"));
  const firstStore = await ChainStore.open(genesis(), firstDir);
  const secondStore = await ChainStore.open(genesis(), secondDir);
  const first = new NodeService(firstStore, await SigningJournal.open(firstDir), validatorOnePrivate);
  const second = new NodeService(secondStore, await SigningJournal.open(secondDir), validatorTwoPrivate);
  const server = createRpcServer(first);
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("View-change test server has no TCP address");
    const peers = new PeerClient([`http://127.0.0.1:${address.port}`]);
    const roundOneTime = genesis().timestampMs + 60_000;
    const block = await produceFinalizedBlock(second, peers, validatorTwoPrivate, roundOneTime);
    assert.ok(block);
    assert.equal(block.header.round, 1);
    assert.equal(block.roundCertificate.length, 2);
    assert.equal(block.attestations.length, 2);
    assert.equal(first.status().height, 1);
    assert.equal(second.status().tipHash, first.status().tipHash);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});

test("validators cannot jump view-change rounds without the predecessor quorum certificate", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-round-a-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-round-b-"));
  try {
    const first = new NodeService(
      await ChainStore.open(genesis(), firstDir),
      await SigningJournal.open(firstDir),
      validatorOnePrivate
    );
    const second = new NodeService(
      await ChainStore.open(genesis(), secondDir),
      await SigningJournal.open(secondDir),
      validatorTwoPrivate
    );
    const now = genesis().timestampMs + 90_000;
    await assert.rejects(() => first.requestSkipVote(1, 1, [], now), /skip quorum/);
    const roundZero = [
      await first.requestSkipVote(1, 0, [], now),
      await second.requestSkipVote(1, 0, [], now)
    ];
    const roundOne = [
      await first.requestSkipVote(1, 1, roundZero, now),
      await second.requestSkipVote(1, 1, roundZero, now)
    ];
    const proposal = first.store.chain.produceBlock([], validatorOnePrivate, {
      round: 2,
      timestampMs: now,
      roundCertificate: roundOne
    });
    assert.equal(proposal.header.round, 2);
    assert.doesNotThrow(() => first.store.chain.validateProposal(proposal, now));
  } finally {
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});

test("validator rotation requires current-set quorum and activates after the delay", () => {
  const chain = new ZyronChain(genesis());
  const validators = [
    { address: newValidatorOne, publicKey: newValidatorOnePublic },
    { address: newValidatorTwo, publicKey: newValidatorTwoPublic }
  ];
  const approvalInput = {
    chainId: genesis().chainId,
    nonce: 1,
    sender: validatorOne,
    activationHeight: 101,
    validators
  };
  const approvals = [
    createValidatorApproval(approvalInput, validatorOnePrivate, validatorOnePublic),
    createValidatorApproval(approvalInput, validatorTwoPrivate, validatorTwoPublic)
  ];
  const update = createValidatorSetUpdate(
    { ...approvalInput, approvals, timestampMs: 1_700_000_000_100 },
    validatorOnePrivate,
    validatorOnePublic
  );
  let block = chain.produceBlock([update], validatorOnePrivate, { timestampMs: 1_700_000_000_200 });
  block = chain.attestBlock(block, validatorOnePrivate);
  block = chain.attestBlock(block, validatorTwoPrivate);
  chain.acceptBlock(block, 1_700_000_000_200);

  assert.deepEqual(chain.validatorsAt(100).map((validator) => validator.address), [validatorOne, validatorTwo]);
  assert.deepEqual(chain.validatorsAt(101).map((validator) => validator.address), [newValidatorOne, newValidatorTwo]);
  assert.equal(chain.getState().nonce(validatorOne), 1);

  for (let height = 2; height <= 100; height += 1) {
    const proposerKey = height % 2 === 0 ? validatorTwoPrivate : validatorOnePrivate;
    let empty = chain.produceBlock([], proposerKey, { timestampMs: 1_700_000_000_200 + height });
    empty = chain.attestBlock(empty, validatorOnePrivate);
    empty = chain.attestBlock(empty, validatorTwoPrivate);
    chain.acceptBlock(empty, 1_700_000_000_200 + height);
  }
  assert.equal(chain.height, 100);
  let activated = chain.produceBlock([], newValidatorOnePrivate, { timestampMs: 1_700_000_000_500 });
  assert.throws(() => chain.attestBlock(activated, validatorOnePrivate), /not in validator set/);
  activated = chain.attestBlock(activated, newValidatorOnePrivate);
  activated = chain.attestBlock(activated, newValidatorTwoPrivate);
  chain.acceptBlock(activated, 1_700_000_000_500);
  assert.equal(chain.height, 101);
});

test("validator rotation rejects insufficient quorum and premature activation", () => {
  const chain = new ZyronChain(genesis());
  const validators = [{ address: newValidatorOne, publicKey: newValidatorOnePublic }];
  const base = {
    chainId: genesis().chainId,
    nonce: 1,
    sender: validatorOne,
    activationHeight: 101,
    validators
  };
  const oneApproval = [createValidatorApproval(base, validatorOnePrivate, validatorOnePublic)];
  const insufficient = createValidatorSetUpdate(
    { ...base, approvals: oneApproval, timestampMs: 1_700_000_000_100 },
    validatorOnePrivate,
    validatorOnePublic
  );
  assert.throws(
    () => chain.produceBlock([insufficient], validatorOnePrivate, { timestampMs: 1_700_000_000_200 }),
    /quorum not reached/
  );

  const earlyBase = { ...base, activationHeight: 100 };
  const earlyApprovals = [
    createValidatorApproval(earlyBase, validatorOnePrivate, validatorOnePublic),
    createValidatorApproval(earlyBase, validatorTwoPrivate, validatorTwoPublic)
  ];
  const early = createValidatorSetUpdate(
    { ...earlyBase, approvals: earlyApprovals, timestampMs: 1_700_000_000_100 },
    validatorOnePrivate,
    validatorOnePublic
  );
  assert.throws(
    () => chain.produceBlock([early], validatorOnePrivate, { timestampMs: 1_700_000_000_200 }),
    /activation is too soon/
  );
});

test("validator schedule is reconstructed from finalized history after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-rotation-store-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    const validators = [
      { address: newValidatorOne, publicKey: newValidatorOnePublic },
      { address: newValidatorTwo, publicKey: newValidatorTwoPublic }
    ];
    const approvalInput = {
      chainId: genesis().chainId,
      nonce: 1,
      sender: validatorOne,
      activationHeight: 101,
      validators
    };
    const update = createValidatorSetUpdate(
      {
        ...approvalInput,
        approvals: [
          createValidatorApproval(approvalInput, validatorOnePrivate, validatorOnePublic),
          createValidatorApproval(approvalInput, validatorTwoPrivate, validatorTwoPublic)
        ],
        timestampMs: 1_700_000_000_100
      },
      validatorOnePrivate,
      validatorOnePublic
    );
    let block = store.chain.produceBlock([update], validatorOnePrivate, { timestampMs: 1_700_000_000_200 });
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    await store.commitFinalizedBlock(block, 1_700_000_000_200);

    const reopened = await ChainStore.open(genesis(), directory);
    assert.deepEqual(reopened.chain.validatorsAt(101).map((validator) => validator.address), [newValidatorOne, newValidatorTwo]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("protocol v2 activation deterministically migrates the finalized v1 ledger to sparse state", () => {
  const chain = new ZyronChain(genesis());
  const proposal = {
    chainId: genesis().chainId,
    nonce: 1,
    sender: validatorOne,
    activationHeight: 101,
    protocolVersion: 2
  };
  const upgrade = createProtocolUpgrade(
    {
      ...proposal,
      approvals: [
        createProtocolUpgradeApproval(proposal, validatorOnePrivate, validatorOnePublic),
        createProtocolUpgradeApproval(proposal, validatorTwoPrivate, validatorTwoPublic)
      ],
      timestampMs: 1_700_000_000_100
    },
    validatorOnePrivate,
    validatorOnePublic
  );
  let first = chain.produceBlock([upgrade], validatorOnePrivate, { timestampMs: 1_700_000_000_200 });
  first = chain.attestBlock(first, validatorOnePrivate);
  first = chain.attestBlock(first, validatorTwoPrivate);
  chain.acceptBlock(first, 1_700_000_000_200);

  for (let height = 2; height <= 100; height += 1) {
    const proposerKey = height % 2 === 0 ? validatorTwoPrivate : validatorOnePrivate;
    let block = chain.produceBlock([], proposerKey, { timestampMs: 1_700_000_000_200 + height });
    block = chain.attestBlock(block, validatorOnePrivate);
    block = chain.attestBlock(block, validatorTwoPrivate);
    chain.acceptBlock(block, 1_700_000_000_200 + height);
  }

  const v1Root = chain.getState().root();
  const migrated = stateV2FromLedgerSnapshot(chain.getState().snapshot());
  let activation = chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_001_000 });
  assert.equal(activation.header.version, 2);
  assert.equal(activation.header.stateRoot, migrated.root());
  assert.notEqual(activation.header.stateRoot, v1Root);
  activation = chain.attestBlock(activation, validatorOnePrivate);
  activation = chain.attestBlock(activation, validatorTwoPrivate);
  chain.acceptBlock(activation, 1_700_000_001_000);

  const transfer = createTransfer(
    {
      chainId: genesis().chainId,
      nonce: 1,
      sender: alice,
      receiver: bob,
      amountAtoms: 1_000,
      feeAtoms: 10,
      timestampMs: 1_700_000_001_001
    },
    alicePrivate,
    alicePublic
  );
  let next = chain.produceBlock([transfer], validatorTwoPrivate, { timestampMs: 1_700_000_001_002 });
  assert.equal(next.header.version, 2);
  assert.notEqual(next.header.stateRoot, activation.header.stateRoot);
  next = chain.attestBlock(next, validatorOnePrivate);
  next = chain.attestBlock(next, validatorTwoPrivate);
  chain.acceptBlock(next, 1_700_000_001_002);
  assert.equal(chain.balance(bob), 1_000);
});

test("protocol upgrade requires validator quorum, activates at a delayed height, and fail-stops unsupported binaries", () => {
  const chain = new ZyronChain(genesis());
  const proposal = {
    chainId: genesis().chainId,
    nonce: 1,
    sender: validatorOne,
    activationHeight: 101,
    protocolVersion: 3
  };
  const upgrade = createProtocolUpgrade(
    {
      ...proposal,
      approvals: [
        createProtocolUpgradeApproval(proposal, validatorOnePrivate, validatorOnePublic),
        createProtocolUpgradeApproval(proposal, validatorTwoPrivate, validatorTwoPublic)
      ],
      timestampMs: 1_700_000_000_100
    },
    validatorOnePrivate,
    validatorOnePublic
  );
  let first = chain.produceBlock([upgrade], validatorOnePrivate, { timestampMs: 1_700_000_000_200 });
  first = chain.attestBlock(first, validatorOnePrivate);
  first = chain.attestBlock(first, validatorTwoPrivate);
  chain.acceptBlock(first, 1_700_000_000_200);
  assert.equal(chain.protocolVersionAt(100), 1);
  assert.equal(chain.protocolVersionAt(101), 3);

  for (let height = 2; height <= 100; height += 1) {
    const proposerKey = height % 2 === 0 ? validatorTwoPrivate : validatorOnePrivate;
    let block = chain.produceBlock([], proposerKey, { timestampMs: 1_700_000_000_200 + height });
    block = chain.attestBlock(block, validatorOnePrivate);
    block = chain.attestBlock(block, validatorTwoPrivate);
    chain.acceptBlock(block, 1_700_000_000_200 + height);
  }
  assert.equal(chain.height, 100);
  assert.throws(
    () => chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_001_000 }),
    /Protocol version 3 is not supported by this binary/
  );
});

test("protocol upgrade rejects weak or premature governance approvals", () => {
  const chain = new ZyronChain(genesis());
  const base = {
    chainId: genesis().chainId,
    nonce: 1,
    sender: validatorOne,
    activationHeight: 101,
    protocolVersion: 2
  };
  const weak = createProtocolUpgrade(
    {
      ...base,
      approvals: [createProtocolUpgradeApproval(base, validatorOnePrivate, validatorOnePublic)],
      timestampMs: 1_700_000_000_100
    },
    validatorOnePrivate,
    validatorOnePublic
  );
  assert.throws(
    () => chain.produceBlock([weak], validatorOnePrivate, { timestampMs: 1_700_000_000_200 }),
    /quorum not reached/
  );

  const earlyBase = { ...base, activationHeight: 100 };
  const early = createProtocolUpgrade(
    {
      ...earlyBase,
      approvals: [
        createProtocolUpgradeApproval(earlyBase, validatorOnePrivate, validatorOnePublic),
        createProtocolUpgradeApproval(earlyBase, validatorTwoPrivate, validatorTwoPublic)
      ],
      timestampMs: 1_700_000_000_100
    },
    validatorOnePrivate,
    validatorOnePublic
  );
  assert.throws(
    () => chain.produceBlock([early], validatorOnePrivate, { timestampMs: 1_700_000_000_200 }),
    /activation is too soon/
  );
});

test("protocol upgrade and rollback schedule is reconstructed from finalized history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-protocol-store-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    const upgradeBase = {
      chainId: genesis().chainId,
      nonce: 1,
      sender: validatorOne,
      activationHeight: 101,
      protocolVersion: 2
    };
    const rollbackBase = {
      ...upgradeBase,
      nonce: 2,
      activationHeight: 201,
      protocolVersion: 1
    };
    const upgrade = createProtocolUpgrade(
      {
        ...upgradeBase,
        approvals: [
          createProtocolUpgradeApproval(upgradeBase, validatorOnePrivate, validatorOnePublic),
          createProtocolUpgradeApproval(upgradeBase, validatorTwoPrivate, validatorTwoPublic)
        ],
        timestampMs: 1_700_000_000_100
      },
      validatorOnePrivate,
      validatorOnePublic
    );
    const rollback = createProtocolUpgrade(
      {
        ...rollbackBase,
        approvals: [
          createProtocolUpgradeApproval(rollbackBase, validatorOnePrivate, validatorOnePublic),
          createProtocolUpgradeApproval(rollbackBase, validatorTwoPrivate, validatorTwoPublic)
        ],
        timestampMs: 1_700_000_000_101
      },
      validatorOnePrivate,
      validatorOnePublic
    );
    let block = store.chain.produceBlock([upgrade, rollback], validatorOnePrivate, { timestampMs: 1_700_000_000_200 });
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    await store.commitFinalizedBlock(block, 1_700_000_000_200);

    const reopened = await ChainStore.open(genesis(), directory);
    assert.equal(reopened.chain.protocolVersionAt(100), 1);
    assert.equal(reopened.chain.protocolVersionAt(101), 2);
    assert.equal(reopened.chain.protocolVersionAt(200), 2);
    assert.equal(reopened.chain.protocolVersionAt(201), 1);
    assert.equal(reopened.chain.getState().nonce(validatorOne), 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("four validators converge across 120 blocks with repeated proposer-failure view changes", () => {
  const fourValidatorGenesis: GenesisConfig = {
    ...genesis(),
    validators: [
      { address: validatorOne, publicKey: validatorOnePublic },
      { address: validatorTwo, publicKey: validatorTwoPublic },
      { address: newValidatorOne, publicKey: newValidatorOnePublic },
      { address: newValidatorTwo, publicKey: newValidatorTwoPublic }
    ]
  };
  const validatorPrivates = [
    validatorOnePrivate,
    validatorTwoPrivate,
    newValidatorOnePrivate,
    newValidatorTwoPrivate
  ];
  const validatorPublics = [
    validatorOnePublic,
    validatorTwoPublic,
    newValidatorOnePublic,
    newValidatorTwoPublic
  ];
  const chains = Array.from({ length: 4 }, () => new ZyronChain(fourValidatorGenesis));

  for (let height = 1; height <= 120; height += 1) {
    const round = height % 7 === 0 ? 1 : 0;
    const producer = chains[0]!;
    const tx = createTransfer(
      {
        chainId: fourValidatorGenesis.chainId,
        nonce: height,
        sender: alice,
        receiver: bob,
        amountAtoms: 1,
        feeAtoms: 0,
        timestampMs: fourValidatorGenesis.timestampMs + (height * 100) - 10
      },
      alicePrivate,
      alicePublic
    );
    const roundCertificate = round === 0 ? [] : [0, 1, 2].map((index) => createRoundSkipVote({
      chainId: fourValidatorGenesis.chainId,
      height,
      round: 0,
      previousHash: producer.tip.hash,
      validatorPrivateKey: validatorPrivates[index]!,
      validatorPublicKey: validatorPublics[index]!
    }));
    const proposerIndex = (height - 1 + round) % validatorPrivates.length;
    let block = producer.produceBlock([tx], validatorPrivates[proposerIndex]!, {
      round,
      roundCertificate,
      timestampMs: fourValidatorGenesis.timestampMs + (height * 100)
    });
    for (const index of [0, 1, 2]) block = producer.attestBlock(block, validatorPrivates[index]!);
    for (const chain of chains) {
      chain.acceptBlock(block, fourValidatorGenesis.timestampMs + (height * 100));
    }
  }

  assert.equal(chains[0]!.height, 120);
  assert.equal(chains[0]!.getState().balance(bob), 120);
  for (const chain of chains.slice(1)) {
    assert.equal(chain.tip.hash, chains[0]!.tip.hash);
    assert.equal(chain.getState().root(), chains[0]!.getState().root());
  }
});

test("four-validator network preserves safety across a 2/2 partition and catches up the isolated node after quorum heals", async () => {
  const fourValidatorGenesis: GenesisConfig = {
    ...genesis(),
    validators: [
      { address: validatorOne, publicKey: validatorOnePublic },
      { address: validatorTwo, publicKey: validatorTwoPublic },
      { address: newValidatorOne, publicKey: newValidatorOnePublic },
      { address: newValidatorTwo, publicKey: newValidatorTwoPublic }
    ]
  };
  const keys = [validatorOnePrivate, validatorTwoPrivate, newValidatorOnePrivate, newValidatorTwoPrivate];
  const directories = await Promise.all(keys.map(() => mkdtemp(join(tmpdir(), "zyron-partition-"))));
  const services: NodeService[] = [];
  const servers: ReturnType<typeof createRpcServer>[] = [];
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const store = await ChainStore.open(fourValidatorGenesis, directories[index]!);
      services.push(new NodeService(store, await SigningJournal.open(directories[index]!), keys[index]!));
    }
    for (const service of services.slice(0, 3)) {
      const server = createRpcServer(service);
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolveListen());
      });
      servers.push(server);
    }
    const urls = servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Partition test server has no TCP address");
      return `http://127.0.0.1:${address.port}`;
    });
    const now = fourValidatorGenesis.timestampMs + 30_000;

    const blocked = await produceFinalizedBlock(services[0]!, new PeerClient([urls[1]!]), validatorOnePrivate, now);
    assert.equal(blocked, null);
    assert.equal(services[0]!.status().height, 0);
    assert.equal(services[1]!.status().height, 0);
    assert.equal(services[2]!.status().height, 0);
    assert.equal(services[3]!.status().height, 0);

    const finalized = await produceFinalizedBlock(
      services[0]!,
      new PeerClient([urls[1]!, urls[2]!]),
      validatorOnePrivate,
      now
    );
    assert.ok(finalized);
    assert.equal(finalized.attestations.length, 3);
    assert.equal(services[0]!.status().height, 1);
    assert.equal(services[1]!.status().height, 1);
    assert.equal(services[2]!.status().height, 1);
    assert.equal(services[3]!.status().height, 0);

    const caughtUp = await new PeerClient([urls[0]!]).syncFrom(urls[0]!, services[3]!);
    assert.equal(caughtUp, 1);
    assert.equal(services[3]!.status().tipHash, services[0]!.status().tipHash);
  } finally {
    for (const server of servers) {
      if (server.listening) {
        await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      }
    }
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
});

test("follower rejects a proposal beyond the allowed future clock skew", () => {
  const producer = new ZyronChain(genesis());
  const follower = new ZyronChain(genesis());
  const future = genesis().timestampMs + 120_001;
  const proposal = producer.produceBlock([], validatorOnePrivate, { timestampMs: future });
  assert.throws(() => follower.validateProposal(proposal, genesis().timestampMs), /too far in future/);
});

test("chain store fails closed on a truncated or corrupt finalized block record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-corrupt-store-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    let block = store.chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    await store.commitFinalizedBlock(block, 1_700_000_000_100);
    await appendFile(join(directory, "blocks.ndjson"), "{\"header\":", "utf8");
    await assert.rejects(() => ChainStore.open(genesis(), directory), /Corrupt stored block/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
