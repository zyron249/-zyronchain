// F-02 regression: a network that finalized nothing for longer than the old
// one-tick catch-up window (BLOCK_INTERVAL_MS + 65 * ROUND_WINDOW_MS, ~33 min)
// must resume block production with bounded work per tick, under the legacy
// skip-certificate protocol (v1) and under protocol v6.
//
// Legacy heights: reaching round R needs a skip-certificate chain for rounds
// 0..R-1 (each skip vote for round r requires a quorum certificate for r-1),
// so the work to resume after a long stall is inherently proportional to R.
// It must be spread over ticks (at most PER_TICK_SKIP_ROUNDS skip rounds per
// producer call) instead of being refused forever.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  BLOCK_INTERVAL_MS,
  ROUND_WINDOW_MS,
  NodeService,
  produceFinalizedBlock,
  type ConsensusPeerClient
} from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import type { Block, GenesisConfig, RoundSkipVote } from "../src/types.js";
import {
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  openValidator,
  testNetwork,
  type TestValidator
} from "./support/consensus-harness.js";
import { V6Sim } from "./support/v6-sim.js";

/** Upper bound on skip-certificate rounds one producer call may work on. */
const PER_TICK_SKIP_ROUNDS = 64;
const TICK_MS = BLOCK_INTERVAL_MS; // the CLI's legacy production tick
const MINUTE = 60_000;

function wallClockRound(tipTimestampMs: number, nowMs: number): number {
  return Math.floor((nowMs - tipTimestampMs - BLOCK_INTERVAL_MS) / ROUND_WINDOW_MS);
}

/** Ticks needed when every tick may advance the certificate chain by PER_TICK_SKIP_ROUNDS while the target moves by one round. */
function tickBound(initialRound: number): number {
  return Math.ceil(initialRound / (PER_TICK_SKIP_ROUNDS - 1)) + 2;
}

function countingPeers(inner: ConsensusPeerClient, counter: { skipRequests: number }): ConsensusPeerClient {
  return {
    ...inner,
    requestRoundSkips: (height: number, round: number, previousCertificate?: RoundSkipVote[]) => {
      counter.skipRequests += 1;
      return inner.requestRoundSkips(height, round, previousCertificate);
    }
  };
}

const singlePrivate = "71".padStart(64, "0");
const singlePublic = publicKeyFromPrivate(singlePrivate);
const genesisTimestamp = 1_700_000_000_000;

function singleGenesis(chainId: string): GenesisConfig {
  const pool = addressFromPublicKey(publicKeyFromPrivate("73".padStart(64, "0")));
  return {
    chainId,
    timestampMs: genesisTimestamp,
    validators: [{ address: addressFromPublicKey(singlePublic), publicKey: singlePublic }],
    activityOracles: [publicKeyFromPrivate("72".padStart(64, "0"))],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 1_000_000 }]
  };
}

for (const [label, stallMs] of [["40 minutes", 40 * MINUTE], ["1 day", 24 * 60 * MINUTE]] as const) {
  test(`F-02 resume-after-long-stall-bounded-work: a single legacy validator resumes after ${label} without a finalized block`, { timeout: 300_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zyron-f02-single-"));
    const journal = await SigningJournal.open(dir);
    try {
      const service = new NodeService(await ChainStore.open(singleGenesis(`zyron-f02-single-${stallMs}`), dir), journal, singlePrivate);
      const startMs = genesisTimestamp + stallMs;
      const initialRound = wallClockRound(genesisTimestamp, startMs);
      assert.ok(initialRound > PER_TICK_SKIP_ROUNDS, "the stall exceeds the old one-tick catch-up window");
      const counter = { skipRequests: 0 };
      const peers = countingPeers({ requestAttestations: async () => [], requestRoundSkips: async () => [], broadcastBlock: async () => {} }, counter);

      let produced: Block | null = null;
      let ticks = 0;
      for (let nowMs = startMs; ticks < tickBound(initialRound) && !produced; nowMs += TICK_MS) {
        ticks += 1;
        counter.skipRequests = 0;
        produced = await produceFinalizedBlock(service, peers, singlePrivate, nowMs);
        assert.ok(counter.skipRequests <= PER_TICK_SKIP_ROUNDS, `tick ${ticks} worked on ${counter.skipRequests} skip rounds`);
        if (produced) {
          assert.equal(produced.header.round, wallClockRound(genesisTimestamp, nowMs), "the resumed block uses the wall-clock round");
          assert.equal(produced.header.timestampMs, nowMs);
        }
      }
      assert.ok(produced, `no block after ${ticks} ticks (initial round ${initialRound})`);
      assert.equal(service.status().height, 1);

      // After resuming, the next height is produced normally in round 0.
      const next = await produceFinalizedBlock(service, peers, singlePrivate, produced.header.timestampMs + BLOCK_INTERVAL_MS);
      assert.ok(next);
      assert.equal(next.header.round, 0);
      assert.equal(service.status().height, 2);
    } finally {
      journal.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

async function legacyCluster(n: number, chainId: string): Promise<{ network: ReturnType<typeof testNetwork>; validators: TestValidator[] }> {
  const network = testNetwork(n, 0x51, chainId);
  const validators: TestValidator[] = [];
  for (let index = 0; index < n; index += 1) validators.push(await openValidator(network, index, []));
  return { network, validators };
}

test("F-02 resume-after-long-stall-bounded-work: a 4-validator legacy network resumes after a 45-minute outage", { timeout: 300_000 }, async () => {
  const { network, validators } = await legacyCluster(4, "zyron-f02-legacy-4");
  try {
    const tip = network.genesis.timestampMs;
    let nowMs = tip + 45 * MINUTE;
    const initialRound = wallClockRound(tip, nowMs);
    assert.ok(initialRound > PER_TICK_SKIP_ROUNDS);
    const memory = new MemoryNetwork(validators, () => nowMs);
    const counters = validators.map(() => ({ skipRequests: 0 }));
    const peers = validators.map((_, index) => countingPeers(memory.peersFor(index), counters[index]!));

    let ticks = 0;
    while (ticks < tickBound(initialRound) && !validators.every((validator) => validator.service.status().height >= 1)) {
      ticks += 1;
      for (let index = 0; index < validators.length; index += 1) {
        counters[index]!.skipRequests = 0;
        if (validators[index]!.service.status().height >= 1) continue;
        await produceFinalizedBlock(validators[index]!.service, peers[index]!, network.privateKeys[index]!, nowMs);
        assert.ok(counters[index]!.skipRequests <= PER_TICK_SKIP_ROUNDS, `v${index} tick ${ticks}: ${counters[index]!.skipRequests} skip rounds`);
      }
      nowMs += TICK_MS;
    }
    const heights = validators.map((validator) => validator.service.status().height);
    assert.deepEqual(heights, [1, 1, 1, 1], `heights ${JSON.stringify(heights)} after ${ticks} ticks (initial round ${initialRound})`);
    const hashes = new Set(validators.map((validator) => validator.service.store.chain.tip.hash));
    assert.equal(hashes.size, 1, "no conflicting finality");
    const block = validators[0]!.service.store.chain.tip;
    assert.ok(block.header.round >= initialRound, "resumed at the wall-clock round, never at a stale round");
    assert.equal(block.roundCertificate.length >= 3, true, "carries a quorum skip certificate for round - 1");

    // Normal production continues at round 0 on the next height.
    nowMs = block.header.timestampMs + BLOCK_INTERVAL_MS;
    for (let index = 0; index < validators.length; index += 1) {
      await produceFinalizedBlock(validators[index]!.service, peers[index]!, network.privateKeys[index]!, nowMs);
    }
    assert.deepEqual(validators.map((validator) => validator.service.status().height), [2, 2, 2, 2]);
    assert.equal(validators[0]!.service.store.chain.tip.header.round, 0);
  } finally {
    await closeValidators(validators);
  }
});

test("F-02 resume-after-long-stall-bounded-work: legacy catch-up survives a validator restart mid catch-up", { timeout: 300_000 }, async () => {
  const { network, validators } = await legacyCluster(4, "zyron-f02-legacy-restart");
  try {
    const tip = network.genesis.timestampMs;
    let nowMs = tip + 90 * MINUTE;
    const initialRound = wallClockRound(tip, nowMs);
    const memory = new MemoryNetwork(validators, () => nowMs);
    let ticks = 0;
    let restarted = false;
    while (ticks < tickBound(initialRound) + 2 && !validators.every((validator) => validator.service.status().height >= 1)) {
      ticks += 1;
      for (let index = 0; index < validators.length; index += 1) {
        if (validators[index]!.service.status().height >= 1) continue;
        await produceFinalizedBlock(validators[index]!.service, memory.peersFor(index), network.privateKeys[index]!, nowMs);
      }
      if (ticks === 1 && !restarted) {
        // Every validator restarts after the first catch-up tick: in-memory
        // progress is lost, durable skip reservations are re-signed idempotently.
        for (let index = 0; index < validators.length; index += 1) {
          const old = validators[index]!;
          old.journal.close();
          validators[index] = await openValidator(network, index, [], old.directory);
        }
        restarted = true;
      }
      nowMs += TICK_MS;
    }
    assert.equal(restarted, true);
    assert.deepEqual(validators.map((validator) => validator.service.status().height), [1, 1, 1, 1], `after ${ticks} ticks`);
    assert.equal(new Set(validators.map((validator) => validator.service.store.chain.tip.hash)).size, 1);
  } finally {
    await closeValidators(validators);
  }
});

for (const [label, stallMs] of [["45 minutes", 45 * MINUTE], ["1 day", 24 * 60 * MINUTE]] as const) {
  test(`F-02 resume-after-long-stall-bounded-work: a 4-validator v6 network resumes after a ${label} outage`, { timeout: 300_000 }, async () => {
    const network = testNetwork(4, 0x61, `zyron-f02-v6-${stallMs}`);
    const prefix = finalizedPrefix(network, 6);
    const validators: TestValidator[] = [];
    for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
    const tip = validators[0]!.service.store.chain.tip.header.timestampMs;
    const sim = new V6Sim({ network, prefix, validators, seed: 7, startMs: tip + stallMs });
    try {
      const firstHeight = validators[0]!.service.status().height + 1;
      const start = sim.time.nowMs;
      validators.forEach((_, index) => sim.startAt(index, start + (index * 1_000)));
      // Every validator was offline for the whole stall; after restart the
      // height must finalize within a few (capped, 120 s) rounds.
      const done = await sim.run(start + 15 * MINUTE, () => validators.every((_, index) => sim.height(index) >= firstHeight + 1));
      sim.stopAll();
      assert.ok(done, `v6 did not resume: heights ${validators.map((_, index) => sim.height(index)).join(",")}`);
      assert.deepEqual((await sim.assertNoConflictingFinality(firstHeight)).conflicts, []);
      assert.deepEqual(sim.ledger.conflicts(), []);
    } finally {
      sim.stopAll();
      await closeValidators(sim.validators);
    }
  });
}
