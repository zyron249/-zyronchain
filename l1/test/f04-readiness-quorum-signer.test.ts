// F-04 residuals (independent retest, round 2): /readyz must not report ready
// when this validator's own consensus attempt for the current tip could not
// collect a quorum (lost peers), or when its configured signer failed. Both
// reasons must clear once consensus progresses or the signer recovers, so no
// stuck not-ready state is possible.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { roundStart } from "../src/consensus-v6.js";
import { BLOCK_INTERVAL_MS, NodeService, ROUND_WINDOW_MS, produceFinalizedBlock } from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { LocalValidatorSigner, type ValidatorSigner } from "../src/validator-signer.js";
import {
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  openValidator,
  proposerIndex,
  testNetwork,
  type TestValidator
} from "./support/consensus-harness.js";

const T = 1_700_000_000_000;
const QUORUM = "consensus-quorum-unreachable";
const SIGNER = "validator-signer-unavailable";

async function legacyCluster(chainId: string, firstKeyByte: number) {
  const network = testNetwork(4, firstKeyByte, chainId, T);
  const validators: TestValidator[] = [];
  for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, []));
  let clock = 0;
  const memory = new MemoryNetwork(validators, () => clock);
  return { network, validators, memory, setClock: (value: number) => { clock = value; } };
}

test("F-04: an isolated legacy proposer that cannot reach the finality quorum is not ready until a block finalizes", async () => {
  const c = await legacyCluster("f04-quorum-legacy-finality", 0x51);
  try {
    const leader = proposerIndex(c.network, 1, 0);
    const now = T + BLOCK_INTERVAL_MS + 100;
    c.setClock(now);
    const service = c.validators[leader]!.service;
    assert.deepEqual(service.readiness(now).reasons, []);
    for (let index = 0; index < 4; index += 1) if (index !== leader) c.memory.online[index] = false;
    assert.equal(await produceFinalizedBlock(service, c.memory.peersFor(leader), c.network.privateKeys[leader]!, now), null);
    assert.deepEqual(service.readiness(now), { ready: false, height: 0, reasons: [QUORUM] });
    // Peers come back; the same round finalizes and the reason clears.
    for (let index = 0; index < 4; index += 1) c.memory.online[index] = true;
    assert.ok(await produceFinalizedBlock(service, c.memory.peersFor(leader), c.network.privateKeys[leader]!, now));
    assert.deepEqual(service.readiness(now), { ready: true, height: 1, reasons: [] });
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-04: a legacy proposer that cannot collect a round-skip quorum is not ready", async () => {
  const c = await legacyCluster("f04-quorum-legacy-skip", 0x55);
  try {
    // The round-1 proposer must first certify that round 0 was skipped.
    const leader = proposerIndex(c.network, 1, 1);
    const now = T + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS + 100;
    c.setClock(now);
    const service = c.validators[leader]!.service;
    for (let index = 0; index < 4; index += 1) if (index !== leader) c.memory.online[index] = false;
    assert.equal(await produceFinalizedBlock(service, c.memory.peersFor(leader), c.network.privateKeys[leader]!, now), null);
    assert.deepEqual(service.readiness(now).reasons, [QUORUM]);
    for (let index = 0; index < 4; index += 1) c.memory.online[index] = true;
    assert.ok(await produceFinalizedBlock(service, c.memory.peersFor(leader), c.network.privateKeys[leader]!, now));
    assert.deepEqual(service.readiness(now).reasons, []);
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-04: an isolated protocol v6 leader that cannot form a prepare QC is not ready until a block finalizes", async () => {
  const network = testNetwork(4, 0x59, "f04-quorum-v6", T);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  try {
    for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
    let clock = 0;
    const memory = new MemoryNetwork(validators, () => clock);
    const height = validators[0]!.service.store.chain.height + 1;
    const leader = proposerIndex(network, height, 0);
    const service = validators[leader]!.service;
    clock = roundStart(service.store.chain.tip.header.timestampMs, 0) + 100;
    for (let index = 0; index < 4; index += 1) if (index !== leader) memory.online[index] = false;
    assert.equal(await produceFinalizedBlock(service, memory.peersFor(leader), network.privateKeys[leader]!, clock), null);
    assert.deepEqual(service.readiness(clock).reasons, [QUORUM]);
    for (let index = 0; index < 4; index += 1) memory.online[index] = true;
    assert.ok(await produceFinalizedBlock(service, memory.peersFor(leader), network.privateKeys[leader]!, clock));
    assert.deepEqual(service.readiness(clock).reasons, []);
  } finally {
    await closeValidators(validators);
  }
});

test("F-04: an observed validator signer failure is not ready and clears after the signer recovers", async () => {
  const network = testNetwork(1, 0x5d, "f04-signer-down", T);
  const dir = await mkdtemp(join(tmpdir(), "zyron-f04-signer-"));
  const journal = await SigningJournal.open(dir);
  try {
    const local = new LocalValidatorSigner(network.privateKeys[0]!);
    let down = true;
    const signer: ValidatorSigner = {
      publicKey: local.publicKey,
      signCanonical: async (...args) => {
        if (down) throw new Error("fixture signer unavailable");
        return local.signCanonical(...args);
      }
    };
    const service = new NodeService(await ChainStore.open(network.genesis, dir), journal, signer);
    const peers = { requestAttestations: async () => [], requestRoundSkips: async () => [], broadcastBlock: async () => {} };
    const now = T + BLOCK_INTERVAL_MS;
    assert.deepEqual(service.readiness(now).reasons, []);
    await assert.rejects(produceFinalizedBlock(service, peers, signer, now), /fixture signer unavailable/);
    assert.deepEqual(service.readiness(now), { ready: false, height: 0, reasons: [SIGNER] });
    down = false;
    assert.ok(await produceFinalizedBlock(service, peers, signer, now));
    assert.deepEqual(service.readiness(now), { ready: true, height: 1, reasons: [] });
  } finally {
    journal.close();
    await rm(dir, { recursive: true, force: true });
  }
});
