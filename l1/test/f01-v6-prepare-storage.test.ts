// F-01 hardening D-1 (resource exhaustion, safety unaffected): a PREPARE
// request is only stored for later re-proposal once the journal has accepted
// the prepare row. Previously the block file was written before the journal
// check, so an equivocating leader could make a validator write one block file
// per distinct (valid) proposal it sent for a round, without the validator
// ever voting for them, until the height finalized.
import assert from "node:assert/strict";
import test from "node:test";

import { roundStart } from "../src/consensus-v6.js";
import { ConsensusStateStore } from "../src/consensus-state-store.js";
import { produceFinalizedBlock } from "../src/node.js";
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

test("F-01 v6 D-1: refused same-round prepare requests of an equivocating leader are not stored", { timeout: 60_000 }, async () => {
  const network = testNetwork(4, 0xd1, "zyron-f01-d1");
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
  const p0 = proposerIndex(network, H, 0);
  // The byzantine leader signs several round-0 proposals with the same key
  // through separate journals (one twin per extra block).
  const twins: TestValidator[] = [await openValidator(network, p0, prefix), await openValidator(network, p0, prefix)];
  try {
    const tip = validators[0]!.service.store.chain.tip.header.timestampMs;
    const target = [0, 1, 2, 3].find((index) => index !== p0)!;
    let now = roundStart(tip, 0) + 500;
    const requests = [];
    for (const leader of [validators[p0]!, ...twins]) {
      // No prepare request is delivered: each leader instance only signs.
      const memory = new MemoryNetwork(validators.map((validator, index) => index === p0 ? leader : validator), () => now);
      memory.drop = (_from, _to, kind) => kind === "v6-prepare";
      assert.equal(await produceFinalizedBlock(leader.service, memory.peersFor(p0), network.privateKeys[p0]!, now), null);
      const stored = await leader.service.v6StoredProposal(0, now);
      assert.equal(stored.status, "ok");
      if (stored.status !== "ok") return;
      requests.push(stored.request);
      now += 1; // different timestamp => different block for the same (H, 0)
    }
    assert.equal(new Set(requests.map((request) => request.block.hash)).size, requests.length);
    const [first, ...others] = requests as [typeof requests[number], ...typeof requests];
    const victim = validators[target]!;
    const vote = await victim.service.v6Prepare(structuredClone(first), now);
    assert.equal(vote.publicKey, network.publicKeys[target]);
    assert.deepEqual(await victim.service.v6FetchBlock(H, first.block.hash), first.block);
    for (const request of others) {
      await assert.rejects(victim.service.v6Prepare(structuredClone(request), now));
      assert.equal(await victim.journal.consensusState.read(ConsensusStateStore.blockFile(H, request.block.hash)), undefined);
      assert.equal(await victim.service.v6FetchBlock(H, request.block.hash), null);
    }
    // The accepted request is still answered identically on retry.
    const retry = await victim.service.v6Prepare(structuredClone(first), now);
    assert.equal(retry.signature, vote.signature);
    assert.equal(victim.journal.v6Row(H, 0, "prepare"), first.block.hash);
  } finally {
    await closeValidators([...validators, ...twins]);
  }
});
