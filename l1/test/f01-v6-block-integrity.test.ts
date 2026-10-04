// F-01 hardening H-1 (liveness): the v6 block hash covers only the header,
// so a commit request, a stored consensus-state block or a block fetched by
// hash could carry the right header with a different body or signature. Such
// copies must be refused before they are stored for re-proposal; otherwise
// every later re-proposal of the block by that validator fails validation
// at all peers and costs honest-leader rounds (§8.2, §8.3).
import assert from "node:assert/strict";
import test from "node:test";

import { roundStart, type V6CommitRequest } from "../src/consensus-v6.js";
import { ConsensusStateStore } from "../src/consensus-state-store.js";
import { produceFinalizedBlock, validateFetchedV6Block } from "../src/node.js";
import type { Block } from "../src/types.js";
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

async function setup(chainId: string): Promise<{ network: ReturnType<typeof testNetwork>; prefix: Block[]; validators: TestValidator[]; memory: MemoryNetwork; clock: { now: number } }> {
  const network = testNetwork(4, 0xc1, chainId);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
  const clock = { now: 0 };
  return { network, prefix, validators, memory: new MemoryNetwork(validators, () => clock.now), clock };
}

function tamperings(block: Block, prefix: Block[]): Array<[string, Block]> {
  const otherBody = structuredClone(block);
  otherBody.transactions = structuredClone(prefix[0]!.transactions); // the upgrade transaction of height 1
  assert.ok(otherBody.transactions.length > 0);
  const badSignature = structuredClone(block);
  badSignature.signature = `${badSignature.signature!.slice(0, -2)}${badSignature.signature!.endsWith("00") ? "01" : "00"}`;
  const withAttestations = structuredClone(block);
  withAttestations.commitRound = 0;
  return [["different body", otherBody], ["bad proposer signature", badSignature], ["finalized form", withAttestations]];
}

test("F-01 v6 H-1: commit requests, stored files and fetched copies with a tampered body or signature are refused", { timeout: 60_000 }, async () => {
  const { network, prefix, validators, memory, clock } = await setup("zyron-f01-h1-units");
  try {
    const tip = validators[0]!.service.store.chain.tip.header.timestampMs;
    const p0 = proposerIndex(network, H, 0);
    const target = [0, 1, 2, 3].find((index) => index !== p0)!;
    // Round 0: QC forms, but no commit request is delivered.
    memory.drop = (_from, _to, kind) => kind === "v6-commit";
    clock.now = roundStart(tip, 0) + 500;
    assert.equal(await produceFinalizedBlock(validators[p0]!.service, memory.peersFor(p0), network.privateKeys[p0]!, clock.now), null);
    const genuine = memory.captured.find((item) => item.kind === "v6-commit")!.request as V6CommitRequest;
    for (const [label, block] of tamperings(genuine.block, prefix)) {
      await assert.rejects(validators[target]!.service.v6Commit({ qc: genuine.qc, block }, clock.now), Error, label);
      assert.throws(() => validateFetchedV6Block(structuredClone(block), H, genuine.block.hash), Error, label);
    }
    assert.equal(validators[target]!.journal.v6Lock(H), null);
    assert.equal(validators[target]!.journal.v6Row(H, 0, "commit"), undefined);
    assert.equal(validateFetchedV6Block(structuredClone(genuine.block), H, genuine.block.hash).hash, genuine.block.hash);
    // A tampered consensus-state block file is not served, and is replaced by an intact copy.
    const fresh = await openValidator(network, target, prefix);
    try {
      const [, tampered] = tamperings(genuine.block, prefix)[0]!;
      await fresh.journal.consensusState.write(ConsensusStateStore.blockFile(H, genuine.block.hash), tampered);
      assert.equal(await fresh.service.v6FetchBlock(H, genuine.block.hash), null);
      const vote = await fresh.service.v6Commit(structuredClone(genuine), clock.now);
      assert.equal(vote.publicKey, network.publicKeys[target]);
      assert.deepEqual(await fresh.service.v6FetchBlock(H, genuine.block.hash), genuine.block);
    } finally {
      await closeValidators([fresh]);
    }
    // The genuine commit request is still accepted by the validator that refused the tampered ones.
    await validators[target]!.service.v6Commit(structuredClone(genuine), clock.now);
    assert.deepEqual(validators[target]!.journal.v6Lock(H), { round: 0, blockHash: genuine.block.hash });
  } finally {
    await closeValidators(validators);
  }
});

test("F-01 v6 H-1: a byzantine leader's tampered commit cannot make the next honest leader re-propose an invalid copy", { timeout: 60_000 }, async () => {
  const { network, validators, memory, clock } = await setup("zyron-f01-h1-flow");
  try {
    const tip = validators[0]!.service.store.chain.tip.header.timestampMs;
    const p0 = proposerIndex(network, H, 0);
    const p1 = proposerIndex(network, H, 1);
    // Round 0 (byzantine p0): everyone but p1 prepares, so a QC forms; the
    // commit request is withheld from everyone, then p0 sends p1 a copy with
    // the QC'd header and a forged signature.
    memory.drop = (from, to, kind) => from === p0 && ((kind === "v6-prepare" && to === p1) || kind === "v6-commit");
    clock.now = roundStart(tip, 0) + 500;
    assert.equal(await produceFinalizedBlock(validators[p0]!.service, memory.peersFor(p0), network.privateKeys[p0]!, clock.now), null);
    const genuine = memory.captured.find((item) => item.kind === "v6-commit")!.request as V6CommitRequest;
    const forged = structuredClone(genuine);
    forged.block.signature = `${forged.block.signature!.slice(0, -2)}${forged.block.signature!.endsWith("00") ? "01" : "00"}`;
    await assert.rejects(validators[p1]!.service.v6Commit(forged, clock.now));
    assert.equal(validators[p1]!.journal.v6Lock(H), null);
    // p0 crashes; p1 leads round 1 and finalizes (its store holds no forged copy).
    memory.drop = () => false;
    memory.online[p0] = false;
    clock.now = roundStart(tip, 1) + 1_000;
    const block = await produceFinalizedBlock(validators[p1]!.service, memory.peersFor(p1), network.privateKeys[p1]!, clock.now);
    assert.ok(block, `round 1 failed: ${JSON.stringify(memory.errors.slice(-3))}`);
    assert.equal(block.commitRound, 1);
    for (const index of [0, 1, 2, 3].filter((item) => item !== p0)) assert.equal(validators[index]!.service.status().height, H);
  } finally {
    await closeValidators(validators);
  }
});
