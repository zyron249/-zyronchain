// F-01 characterization (Phase 0): the legacy consensus (protocol v1/v2/v3/v5)
// splits a round permanently when an attestation and a skip vote are reserved
// for the same (height, round) by different validators. These tests reproduce
// the three schedules of spec §11 T1, T1b and T2 deterministically with real
// NodeService instances and fsynced journals, and pin the legacy outcome
// (permanent halt). They pass on the base commit 8a07c0c and must keep passing
// after the v6 change: v1-v5 behaviour is intentionally unchanged, and v6
// (tests in f01-v6-*.test.ts) is the remedy. The legacy reproductions are the
// "fails on base" evidence for T1/T1b/T2, whose v6 assertions are that the same
// schedules finalize.
import assert from "node:assert/strict";
import test from "node:test";

import { BLOCK_INTERVAL_MS, ROUND_WINDOW_MS, produceFinalizedBlock } from "../src/node.js";
import {
  ACTIVATION_HEIGHT,
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  journalRows,
  openValidator,
  proposerIndex,
  testNetwork,
  type TestValidator
} from "./support/consensus-harness.js";

const LEGACY_VERSIONS = [1, 2, 3, 5] as const;
const H = ACTIVATION_HEIGHT;

async function tryRecover(
  validators: TestValidator[],
  network: ReturnType<typeof testNetwork>,
  memory: MemoryNetwork,
  setClock: (ms: number) => void,
  tipMs: number,
  fromRound: number,
  toRound: number
): Promise<number | null> {
  memory.drop = () => false;
  memory.beforeDeliver = () => {};
  for (let index = 0; index < memory.online.length; index += 1) memory.online[index] = true;
  for (let round = fromRound; round <= toRound; round += 1) {
    const now = tipMs + BLOCK_INTERVAL_MS + (round * ROUND_WINDOW_MS) + 500;
    setClock(now);
    const leader = proposerIndex(network, H, round);
    const block = await produceFinalizedBlock(validators[leader]!.service, memory.peersFor(leader), network.privateKeys[leader]!, now);
    if (block) return round;
  }
  return null;
}

for (const protocolVersion of LEGACY_VERSIONS) {
  test(`F-01 legacy v${protocolVersion} (T1 schedule): crossing attest/skip at the round boundary halts n=2 permanently`, { timeout: 60_000 }, async () => {
    const network = testNetwork(2, 0x61, `zyron-f01-legacy-n2-v${protocolVersion}`);
    const prefix = finalizedPrefix(network, protocolVersion);
    const validators: TestValidator[] = [];
    try {
      for (const index of [0, 1]) validators.push(await openValidator(network, index, prefix));
      const tipMs = validators[0]!.service.store.chain.tip.header.timestampMs;
      let clock = tipMs;
      const memory = new MemoryNetwork(validators, () => clock);
      const p0 = proposerIndex(network, H, 0);
      const p1 = proposerIndex(network, H, 1);
      assert.notEqual(p0, p1);
      const now0 = tipMs + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS - 10; // round 0, 10 ms before its end
      const now1 = tipMs + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS + 5; // round 1 has just begun
      let round1: unknown = "not run";
      // The round-0 proposer has reserved attest(H,0); before its attestation
      // request reaches the peer, the peer's round-1 tick reserves skip(H,0).
      memory.beforeDeliver = async (from, _to, kind) => {
        if (from !== p0 || kind !== "attest" || round1 !== "not run") return;
        clock = now1;
        round1 = await produceFinalizedBlock(validators[p1]!.service, memory.peersFor(p1), network.privateKeys[p1]!, now1);
      };
      clock = now0;
      const round0 = await produceFinalizedBlock(validators[p0]!.service, memory.peersFor(p0), network.privateKeys[p0]!, now0);
      assert.equal(round0, null);
      assert.equal(round1, null);
      assert.deepEqual(await journalRows(validators[p0]!), [`${H}:0=attest`]);
      assert.deepEqual(await journalRows(validators[p1]!), [`${H}:0=skip`]);
      assert.ok(memory.errors.some((item) => /Conflicting validator action prevented/.test(item.message)));
      // Full connectivity afterwards does not help: rounds 2..9 never finalize.
      assert.equal(await tryRecover(validators, network, memory, (ms) => { clock = ms; }, tipMs, 2, 9), null);
      for (const validator of validators) assert.equal(validator.service.status().height, H - 1);
    } finally {
      await closeValidators(validators);
    }
  });

  test(`F-01 legacy v${protocolVersion} (T1b schedule): peer offline for the round-0 attempt halts n=2 permanently`, { timeout: 60_000 }, async () => {
    const network = testNetwork(2, 0x61, `zyron-f01-legacy-n2-v${protocolVersion}`);
    const prefix = finalizedPrefix(network, protocolVersion);
    const validators: TestValidator[] = [];
    try {
      for (const index of [0, 1]) validators.push(await openValidator(network, index, prefix));
      const tipMs = validators[0]!.service.store.chain.tip.header.timestampMs;
      let clock = tipMs;
      const memory = new MemoryNetwork(validators, () => clock);
      const p0 = proposerIndex(network, H, 0);
      const p1 = proposerIndex(network, H, 1);
      memory.online[p1] = false;
      clock = tipMs + BLOCK_INTERVAL_MS + 7_000;
      assert.equal(await produceFinalizedBlock(validators[p0]!.service, memory.peersFor(p0), network.privateKeys[p0]!, clock), null);
      memory.online[p1] = true;
      clock = tipMs + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS + 3_000;
      assert.equal(await produceFinalizedBlock(validators[p1]!.service, memory.peersFor(p1), network.privateKeys[p1]!, clock), null);
      assert.deepEqual(await journalRows(validators[p0]!), [`${H}:0=attest`]);
      assert.deepEqual(await journalRows(validators[p1]!), [`${H}:0=skip`]);
      assert.equal(await tryRecover(validators, network, memory, (ms) => { clock = ms; }, tipMs, 2, 9), null);
    } finally {
      await closeValidators(validators);
    }
  });

  test(`F-01 legacy v${protocolVersion} (T2 schedule): n=4 round-0 proposal reaching one peer splits 2 attest / 2 skip and halts`, { timeout: 60_000 }, async () => {
    const network = testNetwork(4, 0x69, `zyron-f01-legacy-t2-v${protocolVersion}`);
    const prefix = finalizedPrefix(network, protocolVersion);
    const validators: TestValidator[] = [];
    try {
      for (const index of [0, 1, 2, 3]) validators.push(await openValidator(network, index, prefix));
      const tipMs = validators[0]!.service.store.chain.tip.header.timestampMs;
      let clock = tipMs;
      const memory = new MemoryNetwork(validators, () => clock);
      const p0 = proposerIndex(network, H, 0);
      const p1 = proposerIndex(network, H, 1);
      const lucky = [0, 1, 2, 3].find((index) => index !== p0 && index !== p1)!;
      memory.drop = (from, to, kind) => from === p0 && kind === "attest" && to !== lucky;
      clock = tipMs + BLOCK_INTERVAL_MS + 5_000;
      assert.equal(await produceFinalizedBlock(validators[p0]!.service, memory.peersFor(p0), network.privateKeys[p0]!, clock), null);
      memory.drop = () => false;
      clock = tipMs + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS + 1_000;
      assert.equal(await produceFinalizedBlock(validators[p1]!.service, memory.peersFor(p1), network.privateKeys[p1]!, clock), null);
      const rows = await Promise.all(validators.map(journalRows));
      assert.equal(rows.filter((list) => list.includes(`${H}:0=attest`)).length, 2);
      assert.equal(rows.filter((list) => list.includes(`${H}:0=skip`)).length, 2);
      assert.equal(await tryRecover(validators, network, memory, (ms) => { clock = ms; }, tipMs, 2, 6), null);
      for (const validator of validators) assert.equal(validator.service.status().height, H - 1);
    } finally {
      await closeValidators(validators);
    }
  });
}
