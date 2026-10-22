// P1-06 (protocol v6 path): the leader of (H, r) can sign any number of
// distinct heavy, invalid prepare requests for its slot. Each one passes the
// O(1) gates (proposal signature, block hash, proposer signature) and used to
// cost a full transaction verification and state replay inside the node
// mutex. After one such failure per slot, further proposals for that slot are
// refused before the expensive stage. The genuine prepare of another slot is
// unaffected.
import assert from "node:assert/strict";
import test from "node:test";

import { createSignedBlock } from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonicalDomain } from "../src/crypto.js";
import { proposalPayload, roundStart, V6_PROPOSAL_DOMAIN, type V6PrepareRequest } from "../src/consensus-v6.js";
import { produceFinalizedBlock } from "../src/node.js";
import { createTransfer } from "../src/transaction.js";
import type { Block, Transaction } from "../src/types.js";
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
const BUDGET = /Proposal validation budget exhausted/;
const attackerPrivate = "77".padStart(64, "0");
const attackerPublic = publicKeyFromPrivate(attackerPrivate);

/** Validly signed v2 transfers from an unfunded key: signatures verify, the replay fails. */
function unfundedTransactions(count: number, chainId: string): Transaction[] {
  const sender = addressFromPublicKey(attackerPublic);
  return Array.from({ length: count }, (_, index) => createTransfer({
    chainId,
    nonce: index + 1,
    sender,
    receiver: sender,
    amountAtoms: 1,
    feeAtoms: 1,
    timestampMs: 1
  }, attackerPrivate, attackerPublic, 2));
}

test("P1-06 v6: distinct heavy invalid prepares from the leader cost one full validation per slot", { timeout: 180_000 }, async () => {
  const network = testNetwork(4, 0xd6, "zyron-p106-v6");
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
  const clock = { now: 0 };
  const memory = new MemoryNetwork(validators, () => clock.now);
  try {
    const tip = validators[0]!.service.store.chain.tip.header.timestampMs;
    const p0 = proposerIndex(network, H, 0);
    const target = [0, 1, 2, 3].find((index) => index !== p0)!;
    // Capture the leader's genuine prepare without letting the round finish.
    memory.drop = (_from, _to, kind) => kind === "v6-prepare" || kind === "v6-commit";
    clock.now = roundStart(tip, 0) + 500;
    assert.equal(await produceFinalizedBlock(validators[p0]!.service, memory.peersFor(p0), network.privateKeys[p0]!, clock.now), null);
    const genuine = memory.captured.find((item) => item.kind === "v6-prepare")!.request as V6PrepareRequest;
    const leaderKey = network.privateKeys[p0]!;
    const transactions = unfundedTransactions(800, network.chainId);

    const heavy = (offset: number): V6PrepareRequest => {
      const signed = createSignedBlock({
        version: genuine.block.header.version,
        chainId: genuine.block.header.chainId,
        height: genuine.block.header.height,
        round: genuine.block.header.round,
        previousHash: genuine.block.header.previousHash,
        timestampMs: genuine.block.header.timestampMs + 1 + offset,
        transactions,
        stateRoot: genuine.block.header.stateRoot,
        proposerPrivateKey: leaderKey,
        proposerPublicKey: publicKeyFromPrivate(leaderKey)
      });
      const block = { ...structuredClone(genuine.block), ...signed } as Block;
      const unsignedProposal = { ...genuine.proposal, blockHash: block.hash };
      const proposal = { ...unsignedProposal, signature: signCanonicalDomain(V6_PROPOSAL_DOMAIN, proposalPayload(unsignedProposal), leaderKey) };
      return { proposal, block, tc: null };
    };

    const requests = [0, 1, 2, 3].map(heavy);
    assert.equal(new Set(requests.map((request) => request.block.hash)).size, 4);
    const messages = await Promise.all(requests.map((request) =>
      validators[target]!.service.v6Prepare(request, clock.now).then(() => "accepted", (error: Error) => error.message)));
    assert.equal(messages.includes("accepted"), false, JSON.stringify(messages));
    assert.equal(messages.filter((message) => !BUDGET.test(message)).length, 1, JSON.stringify(messages));
    assert.equal(messages.filter((message) => BUDGET.test(message)).length, 3, JSON.stringify(messages));
    // Nothing was signed for the slot.
    assert.equal(validators[target]!.journal.v6Lock(H), null);
  } finally {
    await closeValidators(validators);
  }
});

test("P1-06 v6: a validated prepare is not re-validated, and other proposals for its slot are refused before the expensive stage", { timeout: 180_000 }, async () => {
  const network = testNetwork(4, 0xd7, "zyron-p106-v6-valid");
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
  const clock = { now: 0 };
  const memory = new MemoryNetwork(validators, () => clock.now);
  try {
    const tip = validators[0]!.service.store.chain.tip.header.timestampMs;
    const p0 = proposerIndex(network, H, 0);
    const target = [0, 1, 2, 3].find((index) => index !== p0)!;
    memory.drop = (_from, _to, kind) => kind === "v6-prepare" || kind === "v6-commit";
    clock.now = roundStart(tip, 0) + 500;
    assert.equal(await produceFinalizedBlock(validators[p0]!.service, memory.peersFor(p0), network.privateKeys[p0]!, clock.now), null);
    const genuine = memory.captured.find((item) => item.kind === "v6-prepare")!.request as V6PrepareRequest;
    const service = validators[target]!.service;
    const chain = service.store.chain as unknown as { validateAndApply: (...args: unknown[]) => unknown };
    const original = chain.validateAndApply.bind(service.store.chain);
    let replays = 0;
    chain.validateAndApply = (...args: unknown[]) => { replays += 1; return original(...args); };

    const first = await service.v6Prepare(structuredClone(genuine), clock.now);
    assert.equal(replays, 1);
    for (let index = 0; index < 4; index += 1) {
      const again = await service.v6Prepare(structuredClone(genuine), clock.now);
      assert.deepEqual(again, first);
    }
    assert.equal(replays, 1, "a repeat of a validated prepare must not be re-validated");

    // Another leader-signed proposal for the same slot is refused before the expensive stage.
    const leaderKey = network.privateKeys[p0]!;
    const signed = createSignedBlock({
      version: genuine.block.header.version,
      chainId: genuine.block.header.chainId,
      height: genuine.block.header.height,
      round: genuine.block.header.round,
      previousHash: genuine.block.header.previousHash,
      timestampMs: genuine.block.header.timestampMs + 1,
      transactions: unfundedTransactions(50, network.chainId),
      stateRoot: genuine.block.header.stateRoot,
      proposerPrivateKey: leaderKey,
      proposerPublicKey: publicKeyFromPrivate(leaderKey)
    });
    const block = { ...structuredClone(genuine.block), ...signed } as Block;
    const unsignedProposal = { ...genuine.proposal, blockHash: block.hash };
    const proposal = { ...unsignedProposal, signature: signCanonicalDomain(V6_PROPOSAL_DOMAIN, proposalPayload(unsignedProposal), leaderKey) };
    await assert.rejects(service.v6Prepare({ proposal, block, tc: null }, clock.now), BUDGET);
    assert.equal(replays, 1, "another proposal for a validated slot must not be validated");
  } finally {
    await closeValidators(validators);
  }
});
