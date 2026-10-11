// F-11: pre-authentication CPU exhaustion. Every transaction signature of an
// untrusted block used to be verified before the O(1) proposer binding,
// proposer signature and finality certificate checks, so anyone able to reach
// a consensus endpoint could make a node spend seconds of CPU (inside the
// node-wide mutex) on a forged block with a throwaway key. The cheap
// authentication gates must run first; transaction signatures are still
// verified for every block that passes them.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { blockHash, createSignedBlock, validateBlockEnvelope, validateBlockShape } from "../src/block.js";
import { merkleRoot } from "../src/merkle.js";
import { NodeService } from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { createTransfer } from "../src/transaction.js";
import type { Block, GenesisConfig, Transaction } from "../src/types.js";

const validatorOnePrivate = "01".padStart(64, "0");
const validatorTwoPrivate = "02".padStart(64, "0");
const alicePrivate = "03".padStart(64, "0");
const attackerPrivate = "77".padStart(64, "0");
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const alicePublic = publicKeyFromPrivate(alicePrivate);
const attackerPublic = publicKeyFromPrivate(attackerPrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);
const alice = addressFromPublicKey(alicePublic);
const activityPool = addressFromPublicKey(publicKeyFromPrivate("06".padStart(64, "0")));
const GENESIS_MS = Date.now() - 600_000;

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-f11-cheap-checks",
    timestampMs: GENESIS_MS,
    validators: [
      { address: validatorOne, publicKey: validatorOnePublic },
      { address: validatorTwo, publicKey: validatorTwoPublic }
    ],
    activityOracles: [publicKeyFromPrivate("04".padStart(64, "0"))],
    activityPool,
    allocations: [
      { address: alice, amountAtoms: 1_000_000_000 },
      { address: activityPool, amountAtoms: 5_000_000_000 }
    ]
  };
}

/**
 * Well-formed transfers whose signatures do not verify (the nonce was changed
 * after signing and the txid recomputed): the attacker signs nothing per tx.
 */
function badSignatureTransactions(count: number, chainId: string): Transaction[] {
  const template = createTransfer({
    chainId,
    nonce: 1,
    sender: addressFromPublicKey(attackerPublic),
    receiver: alice,
    amountAtoms: 1,
    feeAtoms: 1,
    timestampMs: GENESIS_MS + 1
  }, attackerPrivate, attackerPublic);
  const out: Transaction[] = [];
  for (let index = 0; index < count; index += 1) {
    const { txid: _txid, ...payload } = { ...template, nonce: index + 2 };
    out.push({ ...payload, txid: sha256Hex(canonicalJson(payload)) } as Transaction);
  }
  return out;
}

/** Validly signed transfers from a throwaway, unfunded key (signed once, offline). */
function signedThrowawayTransactions(count: number, chainId: string): Transaction[] {
  const sender = addressFromPublicKey(attackerPublic);
  return Array.from({ length: count }, (_, index) => createTransfer({
    chainId,
    nonce: index + 1,
    sender,
    receiver: alice,
    amountAtoms: 1,
    feeAtoms: 1,
    timestampMs: GENESIS_MS + 1
  }, attackerPrivate, attackerPublic));
}

function forgedBlock(previous: Block, transactions: Transaction[], options: { signWith?: string; proposerPublic?: string } = {}): Block {
  const header = {
    version: previous.header.version,
    chainId: previous.header.chainId,
    height: previous.header.height + 1,
    round: 0,
    previousHash: previous.hash,
    timestampMs: Date.now() - 1_000,
    transactionRoot: merkleRoot(transactions),
    stateRoot: "00".repeat(32),
    proposer: addressFromPublicKey(options.proposerPublic ?? validatorOnePublic)
  };
  if (options.signWith) {
    return createSignedBlock({
      version: header.version,
      chainId: header.chainId,
      height: header.height,
      round: 0,
      previousHash: header.previousHash,
      timestampMs: header.timestampMs,
      transactions,
      stateRoot: header.stateRoot,
      proposerPrivateKey: options.signWith,
      proposerPublicKey: publicKeyFromPrivate(options.signWith)
    });
  }
  return {
    header,
    transactions,
    hash: blockHash(header),
    proposerPublicKey: options.proposerPublic ?? validatorOnePublic,
    signature: "11".repeat(64),
    roundCertificate: [],
    attestations: []
  };
}

async function withNode<T>(validatorKey: string | undefined, run: (service: NodeService, store: ChainStore) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zyron-f11-"));
  const store = await ChainStore.open(genesis(), directory);
  const journal = validatorKey ? await SigningJournal.open(directory) : undefined;
  try {
    return await run(new NodeService(store, journal, validatorKey), store);
  } finally {
    journal?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const notTransactionSignature = (error: unknown): boolean =>
  error instanceof Error && !/transaction signature/i.test(error.message);

test("F-11: block envelope rejects a forged proposer signature before verifying any transaction signature", async () => {
  await withNode(undefined, async (_service, store) => {
    const block = forgedBlock(store.chain.tip, badSignatureTransactions(50, genesis().chainId));
    assert.throws(
      () => validateBlockEnvelope(structuredClone(block), store.chain.tip, genesis().validators, Date.now(), false, 1),
      /Invalid proposer signature/
    );
  });
});

test("F-11: block envelope rejects an unexpected proposer before verifying any transaction signature", async () => {
  await withNode(undefined, async (_service, store) => {
    // Correctly self-signed by a key that is not the scheduled proposer.
    const block = forgedBlock(store.chain.tip, badSignatureTransactions(50, genesis().chainId), {
      signWith: attackerPrivate
    });
    assert.throws(
      () => validateBlockEnvelope(structuredClone(block), store.chain.tip, genesis().validators, Date.now(), false, 1),
      /Unexpected proposer/
    );
  });
});

test("F-11: attestProposal rejects a forged proposal on the proposer signature, not on its transactions", async () => {
  await withNode(validatorTwoPrivate, async (service, store) => {
    const block = forgedBlock(store.chain.tip, badSignatureTransactions(50, genesis().chainId));
    await assert.rejects(service.attestProposal(structuredClone(block)), /Invalid proposer signature/);
  });
});

test("F-11: acceptFinalizedBlock rejects a forged block on the proposer signature, not on its transactions", async () => {
  await withNode(undefined, async (service, store) => {
    const block = forgedBlock(store.chain.tip, badSignatureTransactions(50, genesis().chainId));
    await assert.rejects(service.acceptFinalizedBlock(structuredClone(block)), /Invalid proposer signature/);
    assert.equal(store.chain.height, 0);
  });
});

test("F-11: acceptFinalizedBlock checks the finality quorum before transaction signatures", async () => {
  await withNode(undefined, async (service, store) => {
    // Even the scheduled proposer's own signature does not make the node
    // verify the body of a block that carries no finality quorum.
    const block = forgedBlock(store.chain.tip, badSignatureTransactions(50, genesis().chainId), {
      signWith: validatorOnePrivate
    });
    await assert.rejects(service.acceptFinalizedBlock(structuredClone(block)), notTransactionSignature);
    await assert.rejects(service.acceptFinalizedBlock(structuredClone(block)), /quorum/i);
    assert.equal(store.chain.height, 0);
  });
});

test("F-11: transaction signatures are still verified for an authenticated proposal", async () => {
  await withNode(validatorTwoPrivate, async (service, store) => {
    const block = forgedBlock(store.chain.tip, badSignatureTransactions(3, genesis().chainId), {
      signWith: validatorOnePrivate
    });
    await assert.rejects(service.attestProposal(structuredClone(block)), /Invalid transaction signature/);
    assert.throws(
      () => validateBlockEnvelope(structuredClone(block), store.chain.tip, genesis().validators, Date.now(), false, 1),
      /Invalid transaction signature/
    );
    // The standalone full shape check keeps verifying every transaction.
    assert.throws(() => validateBlockShape(structuredClone(block)), /Invalid transaction signature/);
  });
});

test("F-11: a near-maximum forged block is rejected quickly and does not stall the node mutex", { timeout: 120_000 }, async () => {
  await withNode(validatorTwoPrivate, async (service, store) => {
    const transactions = signedThrowawayTransactions(3_000, genesis().chainId);
    const block = forgedBlock(store.chain.tip, transactions);
    assert.ok(Buffer.byteLength(canonicalJson(block), "utf8") > 1_000_000);
    const started = performance.now();
    const flood = Array.from({ length: 4 }, () =>
      service.attestProposal(structuredClone(block)).then(
        () => assert.fail("forged proposal accepted"),
        (error: Error) => assert.match(error.message, /Invalid proposer signature/)
      ));
    // A legitimate exclusive operation queued behind the flood must not wait
    // for thousands of signature checks.
    const vote = await service.requestSkipVote(1, 0, []);
    assert.equal(vote.publicKey, validatorTwoPublic);
    const queuedMs = performance.now() - started;
    await Promise.all(flood);
    const totalMs = performance.now() - started;
    // Before the fix each forged request cost ~3,000 secp256k1 verifications
    // (seconds of CPU); the cheap gates take milliseconds.
    assert.ok(queuedMs < 3_000, `exclusive operation was delayed ${queuedMs.toFixed(0)} ms`);
    assert.ok(totalMs < 3_000, `forged flood took ${totalMs.toFixed(0)} ms`);
  });
});
