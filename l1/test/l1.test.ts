import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { Mempool } from "../src/mempool.js";
import { ZyronChain } from "../src/chain.js";
import {
  createActivitySettlement,
  createTransfer,
  createValidatorApproval,
  createValidatorSetUpdate
} from "../src/transaction.js";
import { createRoundSkipVote, validateBlockShape } from "../src/block.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
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
  const selected = pool.selectValid(10, (items) => chain.validatePending(items));
  assert.deepEqual(selected.map((tx) => tx.nonce), [1, 2]);
  assert.deepEqual(chain.selectValidPending(pool.values(), 10).map((tx) => tx.nonce), [1, 2]);
});

test("chain store replays finalized blocks and pins the genesis identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-store-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    let block = store.chain.produceBlock([], validatorOnePrivate, { timestampMs: 1_700_000_000_100 });
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    store.chain.acceptBlock(block, 1_700_000_000_100);
    await store.appendFinalizedBlock(block);

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
    store.chain.acceptBlock(block, 1_700_000_000_200);
    await store.appendFinalizedBlock(block);

    const reopened = await ChainStore.open(genesis(), directory);
    assert.deepEqual(reopened.chain.validatorsAt(101).map((validator) => validator.address), [newValidatorOne, newValidatorTwo]);
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
