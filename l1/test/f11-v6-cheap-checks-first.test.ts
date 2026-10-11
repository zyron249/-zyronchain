// F-11 (protocol v6 paths): prepare/commit requests and blocks fetched for a
// re-proposal are authenticated (certificates, header hash, body root,
// proposer signature) before any transaction signature is verified.
import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { publicKeyFromPrivate } from "../src/crypto.js";
import { roundStart, type V6CommitRequest, type V6PrepareRequest } from "../src/consensus-v6.js";
import { produceFinalizedBlock, validateFetchedV6Block } from "../src/node.js";
import { createTransfer } from "../src/transaction.js";
import type { Block, Transaction } from "../src/types.js";
import { addressFromPublicKey } from "../src/crypto.js";
import {
  ACTIVATION_HEIGHT,
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  openValidator,
  proposerIndex,
  testNetwork,
  type TestValidator
} from "./support/consensus-harness.js";

const H = ACTIVATION_HEIGHT;
const attackerPrivate = "77".padStart(64, "0");
const attackerPublic = publicKeyFromPrivate(attackerPrivate);

function badSignatureTransactions(count: number, chainId: string): Transaction[] {
  const template = createTransfer({
    chainId,
    nonce: 1,
    sender: addressFromPublicKey(attackerPublic),
    receiver: addressFromPublicKey(attackerPublic),
    amountAtoms: 1,
    feeAtoms: 1,
    timestampMs: 1
  }, attackerPrivate, attackerPublic, 2);
  return Array.from({ length: count }, (_, index) => {
    const { txid: _txid, ...payload } = { ...template, nonce: index + 2 };
    return { ...payload, txid: sha256Hex(canonicalJson(payload)) } as Transaction;
  });
}

const notTransactionSignature = (error: unknown): boolean =>
  error instanceof Error && !/transaction signature/i.test(error.message);

test("F-11 v6: forged prepare/commit bodies and fetched blocks are refused before transaction signatures", { timeout: 60_000 }, async () => {
  const network = testNetwork(4, 0xd1, "zyron-f11-v6");
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
  const clock = { now: 0 };
  const memory = new MemoryNetwork(validators, () => clock.now);
  try {
    const tip = validators[0]!.service.store.chain.tip.header.timestampMs;
    const p0 = proposerIndex(network, H, 0);
    const target = [0, 1, 2, 3].find((index) => index !== p0)!;
    memory.drop = (_from, _to, kind) => kind === "v6-commit";
    clock.now = roundStart(tip, 0) + 500;
    assert.equal(await produceFinalizedBlock(validators[p0]!.service, memory.peersFor(p0), network.privateKeys[p0]!, clock.now), null);
    const prepare = memory.captured.find((item) => item.kind === "v6-prepare")!.request as V6PrepareRequest;
    const commit = memory.captured.find((item) => item.kind === "v6-commit")!.request as V6CommitRequest;
    const forgedBody = (block: Block): Block => {
      const copy = structuredClone(block);
      copy.transactions = badSignatureTransactions(20, network.chainId);
      return copy;
    };

    const forgedPrepare = structuredClone(prepare);
    forgedPrepare.block = forgedBody(prepare.block);
    await assert.rejects(validators[target]!.service.v6Prepare(forgedPrepare, clock.now), notTransactionSignature);

    const forgedCommit = structuredClone(commit);
    forgedCommit.block = forgedBody(commit.block);
    await assert.rejects(validators[target]!.service.v6Commit(forgedCommit, clock.now), notTransactionSignature);
    assert.equal(validators[target]!.journal.v6Lock(H), null);

    assert.throws(() => validateFetchedV6Block(forgedBody(commit.block), H, commit.block.hash), notTransactionSignature);
    // The genuine block still passes the full check, transactions included.
    assert.equal(validateFetchedV6Block(structuredClone(commit.block), H, commit.block.hash).hash, commit.block.hash);
    await validators[target]!.service.v6Commit(structuredClone(commit), clock.now);
    assert.deepEqual(validators[target]!.journal.v6Lock(H), { round: 0, blockHash: commit.block.hash });
  } finally {
    await closeValidators(validators);
  }
});
