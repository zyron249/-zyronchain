import assert from "node:assert/strict";
import test from "node:test";

import { validateBlockEnvelope } from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ZyronChain } from "../src/chain.js";
import { merkleRoot } from "../src/merkle.js";
import { createTransfer } from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

/**
 * ZC-CRY-20260930-003: the transaction Merkle tree duplicates the last node on
 * odd levels (Bitcoin CVE-2012-2459 class) and the header does not commit to
 * the transaction count, so a relay can append duplicated transactions without
 * changing the block hash or invalidating proposer/validator signatures.
 */

const validatorPrivate = "51".padStart(64, "0");
const senderPrivate = "52".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const senderPublic = publicKeyFromPrivate(senderPrivate);
const sender = addressFromPublicKey(senderPublic);
const receiver = addressFromPublicKey(publicKeyFromPrivate("53".padStart(64, "0")));

const genesis: GenesisConfig = {
  chainId: "zyron-merkle-review-1",
  timestampMs: 1_700_000_000_000,
  validators: [{ address: addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
  activityOracles: [publicKeyFromPrivate("54".padStart(64, "0"))],
  activityPool: sender,
  allocations: [{ address: sender, amountAtoms: 1_000_000_000 }]
};

test("CRYPTO-REVIEW: odd-level duplication makes distinct transaction lists share a Merkle root (characterization)", () => {
  assert.equal(merkleRoot(["a", "b", "c"]), merkleRoot(["a", "b", "c", "c"]));
  assert.equal(merkleRoot(["a", "b", "c", "d", "e", "f"]), merkleRoot(["a", "b", "c", "d", "e", "f", "e", "f"]));
  assert.notEqual(merkleRoot(["a", "b"]), merkleRoot(["a", "b", "b"]));
});

test("CRYPTO-REVIEW: a relay-mutated block with a duplicated tail is rejected at the envelope boundary", () => {
  const chain = new ZyronChain(genesis);
  const transfers = [1, 2, 3].map((nonce) => createTransfer({
    chainId: genesis.chainId, nonce, sender, receiver, amountAtoms: 10, feeAtoms: 1, timestampMs: genesis.timestampMs + nonce
  }, senderPrivate, senderPublic));
  const timestampMs = genesis.timestampMs + 1_000;
  let block = chain.produceBlock(transfers, validatorPrivate, { timestampMs });
  block = chain.attestBlock(block, validatorPrivate);
  const mutated = { ...block, transactions: [...block.transactions, block.transactions[2]!] };
  assert.equal(merkleRoot(mutated.transactions), block.header.transactionRoot, "same root, same hash, same signatures");

  const validators = chain.validatorsAt(1);
  assert.doesNotThrow(() => validateBlockEnvelope(block, chain.tip, validators, timestampMs));
  assert.throws(() => validateBlockEnvelope(mutated, chain.tip, validators, timestampMs), /Duplicate transaction in block/);
  assert.throws(() => chain.acceptBlock(mutated, timestampMs), /Duplicate transaction/);
  chain.acceptBlock(block, timestampMs);
  assert.equal(chain.height, 1);
});
