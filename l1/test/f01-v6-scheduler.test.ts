// F-01 T13 (event-driven-scheduler): protocol v6 validators are driven by the
// production V6LeaderScheduler (src/v6-scheduler.ts, wired in cli.ts), not by
// the legacy fixed 30 s tick that is phase-locked to process start (§8.6).
// Runs use V6Sim: real NodeService/journal instances on a virtual clock.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { expectedValidator } from "../src/block.js";
import {
  V6_FALLBACK_POLL_MS,
  V6_LEADER_JITTER_MAX_MS,
  V6_LEADER_RETRY_MS,
  V6_ROUND_BASE_MS,
  roundOffset,
  roundStart
} from "../src/consensus-v6.js";
import { produceFinalizedBlock } from "../src/node.js";
import type { Block } from "../src/types.js";
import { V6LeaderScheduler, planV6Wake, v6LeaderStart } from "../src/v6-scheduler.js";
import { closeValidators, finalizedPrefix, openValidator, testNetwork, type TestValidator } from "./support/consensus-harness.js";
import { V6Sim, VirtualTime, seededRandom } from "./support/v6-sim.js";

test("F-01 v6 scheduler plan: leaders act only inside their own slot and never sleep past it", () => {
  assert.equal(V6_FALLBACK_POLL_MS, V6_ROUND_BASE_MS / 10);
  assert.ok(V6_LEADER_RETRY_MS <= 1_000);
  for (const n of [2, 3, 4, 7]) {
    const network = testNetwork(n, 0x31, `zyron-f01-plan-n${n}`);
    const validators = network.genesis.validators;
    const tip = 1_700_000_000_000;
    const height = 101;
    for (const jitterMs of [0, 137, V6_LEADER_JITTER_MAX_MS]) {
      for (const validator of validators) {
        const ownStarts: Array<{ round: number; start: number }> = [];
        for (let round = 0; round < 12; round += 1) {
          if (expectedValidator(validators, height, round).publicKey === validator.publicKey) {
            ownStarts.push({ round, start: v6LeaderStart(tip, round) + jitterMs });
          }
        }
        for (let nowMs = tip; nowMs < tip + roundOffset(9); nowMs += 211) {
          const plan = planV6Wake({ tipTimestampMs: tip, height, validators, publicKey: validator.publicKey, nowMs, jitterMs });
          assert.ok(plan.delayMs >= 0 && plan.delayMs <= V6_FALLBACK_POLL_MS);
          if (plan.act) {
            const { round } = plan.act;
            assert.equal(expectedValidator(validators, height, round).publicKey, validator.publicKey);
            assert.ok(nowMs >= v6LeaderStart(tip, round) + jitterMs, "acted before its slot");
            assert.ok(nowMs < v6LeaderStart(tip, round + 1), "acted after its slot ended");
            if (round === 0) assert.ok(nowMs >= roundStart(tip, 0), "round 0 has no early entry");
          } else {
            assert.ok(plan.delayMs >= 1);
            const next = ownStarts.find((slot) => slot.start > nowMs);
            if (next) assert.ok(nowMs + plan.delayMs <= next.start, `would oversleep slot ${next.round}`);
          }
        }
      }
    }
  }
  // A validator outside the set only polls.
  const network = testNetwork(4, 0x31, "zyron-f01-plan-n4");
  const outsider = testNetwork(1, 0x77, "zyron-f01-plan-outsider").publicKeys[0]!;
  const plan = planV6Wake({ tipTimestampMs: 0, height: 101, validators: network.genesis.validators, publicKey: outsider, nowMs: 40_000, jitterMs: 0 });
  assert.deepEqual(plan, { act: null, delayMs: V6_FALLBACK_POLL_MS });
});

test("F-01 v6 scheduler is idle while the next height is legacy (fallback poll only, no attempt)", async () => {
  const time = new VirtualTime(1_000);
  const delays: number[] = [];
  let attempts = 0;
  const scheduler = new V6LeaderScheduler<Block>({
    context: () => null,
    attempt: async () => { attempts += 1; return null; },
    clock: {
      now: () => time.nowMs,
      setTimeout: (callback, delayMs) => { delays.push(delayMs); return time.setTimeout(callback, delayMs); },
      clearTimeout: (handle) => time.clearTimeout(handle),
      random: () => 0.5
    }
  });
  scheduler.start();
  await time.run(1_000 + (10 * V6_FALLBACK_POLL_MS));
  scheduler.stop();
  assert.equal(attempts, 0);
  assert.deepEqual(delays.slice(1), Array(delays.length - 1).fill(V6_FALLBACK_POLL_MS));
  // stop() cancels the pending timer: nothing runs afterwards.
  const before = delays.length;
  await time.run(time.nowMs + (10 * V6_FALLBACK_POLL_MS));
  assert.equal(delays.length, before);
});

async function openCluster(n: number, chainId: string): Promise<{ network: ReturnType<typeof testNetwork>; prefix: Block[]; validators: TestValidator[] }> {
  const network = testNetwork(n, 0x41 + n, chainId);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  for (let index = 0; index < n; index += 1) validators.push(await openValidator(network, index, prefix));
  return { network, prefix, validators };
}

const HEIGHTS = 20;

function offsetSets(n: number): number[][] {
  const random = seededRandom(1300 + n);
  return [
    Array.from({ length: n }, (_, index) => Math.floor((index * V6_ROUND_BASE_MS) / n)),
    Array.from({ length: n }, (_, index) => (index === 0 ? V6_ROUND_BASE_MS - 1 : index - 1)),
    Array.from({ length: n }, () => Math.floor(random() * V6_ROUND_BASE_MS))
  ];
}

for (const n of [2, 4]) {
  test(`F-01 v6 T13: n=${n} event-driven scheduler finalizes ${HEIGHTS} heights in round 0 for start offsets across the window`, { timeout: 300_000 }, async () => {
    for (const offsets of offsetSets(n)) {
      const { network, prefix, validators } = await openCluster(n, `zyron-f01-t13-n${n}`);
      const sim = new V6Sim({ network, prefix, validators, seed: offsets.reduce((a, b) => a + b, n) });
      try {
        const firstHeight = validators[0]!.service.status().height + 1;
        const tip = sim.time.nowMs;
        offsets.forEach((offset, index) => sim.startAt(index, tip + offset));
        const target = firstHeight + HEIGHTS - 1;
        const done = await sim.run(tip + (HEIGHTS * 120_000), () => validators.every((_, index) => sim.height(index) >= target));
        sim.stopAll();
        assert.ok(done, `offsets ${JSON.stringify(offsets)}: only reached ${sim.maxHeight()}`);
        assert.equal(sim.finality.length, HEIGHTS);
        for (const item of sim.finality) {
          assert.equal(item.commitRound, 0, `offsets ${JSON.stringify(offsets)}: height ${item.height} lost round 0`);
          assert.equal(item.headerRound, 0);
          assert.equal(item.leader, network.publicKeys.indexOf(expectedValidator(network.genesis.validators, item.height, 0).publicKey));
        }
        // Each slot's first attempt happens at roundStart(H, 0) + jitter (<= 250 ms), local time.
        const attempts = sim.schedulers.flatMap((scheduler) => scheduler?.attempts ?? []);
        assert.equal(attempts.length, HEIGHTS, "fault-free run needs exactly one attempt per height");
        for (const attempt of attempts) {
          const [previous] = await validators[0]!.service.store.readFinalizedBlocks(attempt.height - 1, 1, 8_000_000);
          const start = roundStart(previous!.header.timestampMs, 0);
          assert.ok(attempt.atMs >= start && attempt.atMs <= start + V6_LEADER_JITTER_MAX_MS, `attempt at +${attempt.atMs - start} ms`);
          assert.equal(attempt.finalized, true);
        }
        assert.deepEqual((await sim.assertNoConflictingFinality(firstHeight)).conflicts, []);
        assert.deepEqual(sim.ledger.conflicts(), []);
        assert.deepEqual(sim.ledger.conflictingCertificates(), []);
      } finally {
        sim.stopAll();
        await closeValidators(sim.validators);
      }
    }
  });
}

test("F-01 v6 T13: a leader retries a failed attempt within 1 s and re-sends the same proposal", { timeout: 120_000 }, async () => {
  const { network, prefix, validators } = await openCluster(4, "zyron-f01-t13-retry");
  const sim = new V6Sim({ network, prefix, validators, seed: 99 });
  try {
    const firstHeight = validators[0]!.service.status().height + 1;
    const faultHeight = firstHeight + 2;
    const tip = sim.time.nowMs;
    [0, 9_000, 18_000, 27_000].forEach((offset, index) => sim.startAt(index, tip + offset));
    // Transient fault: the leader's prepare requests at faultHeight are lost for 2.5 s.
    let faultStart: number | undefined;
    sim.linkDown = (from, _to, kind, nowMs) => {
      if (kind !== "v6-prepare" || sim.height(from) + 1 !== faultHeight) return false;
      faultStart ??= nowMs;
      return nowMs < faultStart + 2_500;
    };
    const done = await sim.run(tip + 600_000, () => validators.every((_, index) => sim.height(index) >= firstHeight + 3));
    sim.stopAll();
    assert.ok(done);
    const leader = network.publicKeys.indexOf(expectedValidator(network.genesis.validators, faultHeight, 0).publicKey);
    const slot = sim.schedulers[leader]!.attempts.filter((attempt) => attempt.height === faultHeight);
    assert.ok(slot.length >= 3, `expected retries, got ${slot.length}`);
    assert.ok(slot.every((attempt) => attempt.round === 0));
    for (let index = 1; index < slot.length; index += 1) {
      assert.ok(slot[index]!.atMs - slot[index - 1]!.atMs <= V6_LEADER_RETRY_MS, "retry later than 1 s");
    }
    assert.deepEqual(slot.map((attempt) => attempt.finalized), [...Array(slot.length - 1).fill(false), true]);
    const final = sim.finality.find((item) => item.height === faultHeight)!;
    assert.equal(final.commitRound, 0);
    // One proposal and one block per slot: retries re-sent the stored proposal.
    assert.deepEqual(sim.ledger.conflicts(), []);
    assert.deepEqual((await sim.assertNoConflictingFinality(firstHeight)).conflicts, []);
    assert.ok(faultStart !== undefined && final.atMs >= faultStart + 2_500 && final.atMs <= faultStart + 2_500 + V6_LEADER_RETRY_MS);
  } finally {
    sim.stopAll();
    await closeValidators(sim.validators);
  }
});

test("F-01 v6 T13 control: the same transient fault under the legacy fixed 30 s tick costs round 0 (§8.6 path 3)", { timeout: 120_000 }, async () => {
  const { network, prefix, validators } = await openCluster(4, "zyron-f01-t13-retry");
  const sim = new V6Sim({ network, prefix, validators, seed: 99 });
  try {
    const firstHeight = validators[0]!.service.status().height + 1;
    const faultHeight = firstHeight + 2;
    const tip = sim.time.nowMs;
    // Legacy driver: setInterval(produceFinalizedBlock, 30 s) phase-locked to process start.
    [0, 9_000, 18_000, 27_000].forEach((offset, index) => {
      const tick = async (): Promise<void> => {
        sim.time.setTimeout(tick, V6_ROUND_BASE_MS);
        try {
          const block = await produceFinalizedBlock(validators[index]!.service, sim.ledger.wrap(sim.memory.peersFor(index)), network.privateKeys[index]!, sim.localNow(index));
          if (block && !sim.finality.some((item) => item.height === block.header.height)) {
            sim.finality.push({ height: block.header.height, hash: block.hash, commitRound: block.commitRound ?? -1, headerRound: block.header.round, atMs: sim.time.nowMs, leader: index });
          }
        } catch {
        }
      };
      sim.time.setTimeout(tick, offset);
    });
    let faultStart: number | undefined;
    sim.linkDown = (from, _to, kind, nowMs) => {
      if (kind !== "v6-prepare" || sim.height(from) + 1 !== faultHeight) return false;
      faultStart ??= nowMs;
      return nowMs < faultStart + 2_500;
    };
    const done = await sim.run(tip + 900_000, () => validators.every((_, index) => sim.height(index) >= faultHeight));
    assert.ok(done);
    assert.ok(faultStart !== undefined);
    const final = sim.finality.find((item) => item.height === faultHeight)!;
    assert.ok(final.commitRound >= 1, "the fixed tick cannot retry inside round 0");
    // Safety is unaffected by the driver.
    assert.deepEqual(sim.ledger.conflicts(), []);
    assert.deepEqual((await sim.assertNoConflictingFinality(firstHeight)).conflicts, []);
  } finally {
    await closeValidators(sim.validators);
  }
});

test("F-01 local-devnet --v6 is a test-only mode: refuses --local-v5, default devnet:check stays protocol v1", async () => {
  const refused = spawnSync(process.execPath, ["scripts/local-devnet.mjs", "--check", "--v6", "--local-v5"], { encoding: "utf8", windowsHide: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /cannot be combined/);
  const help = spawnSync(process.execPath, ["scripts/local-devnet.mjs", "--help"], { encoding: "utf8", windowsHide: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--v6 \(F-01 test mode\)/);
  assert.match(help.stdout, /never use this on a live network/);
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["devnet:check"], "npm run build && node scripts/local-devnet.mjs --check");
  assert.equal(pkg.scripts["devnet:check:v6"], "npm run build && node scripts/local-devnet.mjs --check --v6");
});
