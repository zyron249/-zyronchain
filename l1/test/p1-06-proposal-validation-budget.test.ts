// P1-06 (F-11 residual): flood by an authenticated proposer. F-11 moved the
// O(1) gates (proposer binding, proposer signature, certificates) before the
// per-transaction work, so a forged block is cheap to refuse. The expected
// proposer of (height, round) can still sign any number of distinct heavy,
// invalid proposals; each one cost thousands of signature verifications and a
// state replay inside the node-wide mutex, delaying honest consensus work
// behind it. An honest proposer signs exactly one block per (height, round),
// and a block that fails the expensive stage against the same tip fails
// deterministically. So after one such failure per (height, round, proposer)
// further distinct proposals for that slot are refused before the expensive
// stage, and a repeat of the failed hash is refused from cache. Failures in the
// cheap gates (a forged proposer signature, a wrong tip) never count, so other
// peers cannot use up an honest proposer's slot.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { blockHash, createSignedBlock } from "../src/block.js";
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
    chainId: "zyron-p106-proposal-budget",
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

function forgedBlock(previous: Block, transactions: Transaction[], options: { signWith?: string; proposerPublic?: string; timestampMs?: number; stateRoot?: string } = {}): Block {
  const header = {
    version: previous.header.version,
    chainId: previous.header.chainId,
    height: previous.header.height + 1,
    round: 0,
    previousHash: previous.hash,
    timestampMs: options.timestampMs ?? Date.now() - 1_000,
    transactionRoot: merkleRoot(transactions),
    stateRoot: options.stateRoot ?? "00".repeat(32),
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
  const directory = await mkdtemp(join(tmpdir(), "zyron-p106-"));
  const store = await ChainStore.open(genesis(), directory);
  const journal = validatorKey ? await SigningJournal.open(directory) : undefined;
  try {
    return await run(new NodeService(store, journal, validatorKey), store);
  } finally {
    journal?.close();
    await rm(directory, { recursive: true, force: true });
  }
}


const BUDGET = /Proposal validation budget exhausted/;

test("P1-06: distinct heavy invalid proposals from the authenticated proposer cost one full validation per (height, round)", { timeout: 180_000 }, async () => {
  await withNode(validatorTwoPrivate, async (service, store) => {
    // Validly signed but unfunded transfers: every signature verifies, the state replay then fails.
    const transactions = signedThrowawayTransactions(1_500, genesis().chainId);
    const base = Date.now() - 5_000;
    const proposals = Array.from({ length: 5 }, (_, index) =>
      forgedBlock(store.chain.tip, transactions, { signWith: validatorOnePrivate, timestampMs: base + index }));
    assert.equal(new Set(proposals.map((block) => block.hash)).size, 5);
    const started = performance.now();
    const outcomes = proposals.map((block) => service.attestProposal(structuredClone(block)).then(
      () => "accepted",
      (error: Error) => error.message
    ));
    // Honest exclusive work queued behind the flood.
    const vote = await service.requestSkipVote(1, 0, []);
    const queuedMs = performance.now() - started;
    assert.equal(vote.publicKey, validatorTwoPublic);
    const messages = await Promise.all(outcomes);
    assert.equal(messages.includes("accepted"), false);
    const heavy = messages.filter((message) => !BUDGET.test(message));
    const refused = messages.filter((message) => BUDGET.test(message));
    assert.equal(heavy.length, 1, `full validations: ${JSON.stringify(messages)} (queued ${queuedMs.toFixed(0)} ms)`);
    assert.equal(refused.length, 4);
    // A repeat of the failed proposal is refused without the expensive stage too.
    await assert.rejects(service.attestProposal(structuredClone(proposals[0]!)), BUDGET);
  });
});

test("P1-06: forged proposer signatures and wrong-tip proposals do not use up the proposer's slot", { timeout: 120_000 }, async () => {
  await withNode(validatorTwoPrivate, async (service, store) => {
    const tip = store.chain.tip;
    for (let index = 0; index < 4; index += 1) {
      // Unauthenticated: refused on the proposer signature.
      await assert.rejects(
        service.attestProposal(forgedBlock(tip, badSignatureTransactions(5, genesis().chainId), { timestampMs: Date.now() - 2_000 + index })),
        /Invalid proposer signature/
      );
      // Authenticated, but not on this node's tip: refused on the cheap previous-hash gate.
      const wrongTip = { ...tip, hash: "ab".repeat(31) + index.toString(16).padStart(2, "0") };
      await assert.rejects(
        service.attestProposal(forgedBlock(wrongTip as Block, [], { signWith: validatorOnePrivate, timestampMs: Date.now() - 2_000 + index })),
        /Wrong previous hash/
      );
    }
    // The honest proposal for (1, 0) is still attested.
    const timestampMs = Date.now() - 1_000;
    const prepared = store.chain.prepareBlock([], validatorOnePublic, { timestampMs });
    const honest = forgedBlock(tip, [], { signWith: validatorOnePrivate, timestampMs, stateRoot: prepared.header.stateRoot });
    assert.equal(honest.hash, prepared.hash);
    const attestation = await service.attestProposal(structuredClone(honest));
    assert.equal(attestation.publicKey, validatorTwoPublic);
  });
});

test("P1-06: the budget is per slot and hash, pruned at the finalized height, and bounded in size", async () => {
  const { ProposalValidationBudget, PROPOSAL_VALIDATION_BUDGET_MESSAGE } = await import("../src/proposal-validation-budget.js");
  const budget = new ProposalValidationBudget(1, 3);
  const slot = (height: number, round = 0) => ProposalValidationBudget.slotKey(height, round, validatorOnePublic);
  budget.assertAllowed(slot(5), "aa");
  budget.recordFailure(slot(5), 5, "aa");
  assert.throws(() => budget.assertAllowed(slot(5), "aa"), new RegExp(PROPOSAL_VALIDATION_BUDGET_MESSAGE));
  assert.throws(() => budget.assertAllowed(slot(5), "bb"), new RegExp(PROPOSAL_VALIDATION_BUDGET_MESSAGE));
  // Other rounds, heights and proposers are separate slots.
  budget.assertAllowed(slot(5, 1), "bb");
  budget.assertAllowed(slot(6), "bb");
  budget.assertAllowed(ProposalValidationBudget.slotKey(5, 0, validatorTwoPublic), "bb");
  // Finalizing height 5 drops its slots.
  budget.pruneThrough(5);
  assert.equal(budget.size(), 0);
  budget.assertAllowed(slot(5), "aa");
  // At most maxSlots slots are kept; the oldest goes first.
  for (const height of [6, 7, 8, 9]) budget.recordFailure(slot(height), height, "cc");
  assert.equal(budget.size(), 3);
  budget.assertAllowed(slot(6), "dd");
  assert.throws(() => budget.assertAllowed(slot(9), "dd"), new RegExp(PROPOSAL_VALIDATION_BUDGET_MESSAGE));
  assert.throws(() => new ProposalValidationBudget(0), /Invalid proposal validation budget/);
});

test("P1-06: a validated proposal is not re-validated, and other proposals for its slot are refused before the expensive stage", { timeout: 120_000 }, async () => {
  await withNode(validatorTwoPrivate, async (service, store) => {
    // Count state replays (the expensive stage after the O(1) gates).
    const chain = store.chain as unknown as { validateAndApply: (...args: unknown[]) => unknown };
    const original = chain.validateAndApply.bind(store.chain);
    let replays = 0;
    chain.validateAndApply = (...args: unknown[]) => { replays += 1; return original(...args); };
    const tip = store.chain.tip;
    const transfer = (nonce: number) => createTransfer({
      chainId: genesis().chainId,
      nonce,
      sender: alice,
      receiver: validatorOne,
      amountAtoms: 1,
      feeAtoms: 1,
      timestampMs: GENESIS_MS + 1
    }, alicePrivate, alicePublic);
    const validProposal = (timestampMs: number, transactions: Transaction[]): Block => {
      const prepared = store.chain.prepareBlock(transactions, validatorOnePublic, { timestampMs });
      const block = forgedBlock(tip, transactions, { signWith: validatorOnePrivate, timestampMs, stateRoot: prepared.header.stateRoot });
      assert.equal(block.hash, prepared.hash);
      return block;
    };
    const base = Date.now() - 3_000;
    const valid = validProposal(base, [transfer(1), transfer(2), transfer(3)]);
    const equivocation = validProposal(base + 1, [transfer(1)]);
    replays = 0;
    const first = await service.attestProposal(structuredClone(valid));
    assert.equal(first.publicKey, validatorTwoPublic);
    assert.equal(replays, 1);
    // Repeats of the validated proposal (for example relayed through several peers)
    // skip the expensive stage and return the existing attestation.
    for (let index = 0; index < 4; index += 1) {
      const again = await service.attestProposal(structuredClone(valid));
      assert.equal(again.signature, first.signature);
    }
    assert.equal(replays, 1, "a repeat of a validated proposal must not be re-validated");
    // A second, otherwise valid proposal for the same slot (an equivocation) is
    // refused before the expensive stage.
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(service.attestProposal(structuredClone(equivocation)), BUDGET);
    }
    assert.equal(replays, 1, "an equivocating proposal for a validated slot must not be validated");
    // The cheap gates still run for a cached hash: a forged signature on the
    // validated block is refused.
    await assert.rejects(service.attestProposal({ ...structuredClone(valid), signature: "11".repeat(64) }), /Invalid proposer signature/);
  });
});
