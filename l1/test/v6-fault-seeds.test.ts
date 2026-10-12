// P0-03: heavy deterministic seed sweep of the v6 fault-injection scenarios
// and crash points. Skipped unless ZYRON_V6_FAULT_SEEDS is set, so the
// per-PR suite stays bounded. Environment:
//   ZYRON_V6_FAULT_SEEDS      "200" (seeds 1..200) or "50-80"
//   ZYRON_V6_FAULT_N          validator counts, default "4,7"
//   ZYRON_V6_FAULT_SCENARIOS  comma list of scenarios and/or "crash-points", default all
//   ZYRON_V6_FAULT_SHARD      "i/k": run only plan items with index % k == i (parallel processes)
//   ZYRON_V6_FAULT_OUT        append one JSON line per run to this file
//   ZYRON_V6_FAULT_CHAOS_MS   override the fault period (virtual ms)
// Example: ZYRON_V6_FAULT_SEEDS=200 ZYRON_V6_FAULT_SHARD=0/6 node --test dist/test/v6-fault-seeds.test.js
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import test from "node:test";

import { CRASH_POINTS, FAULT_SCENARIOS, HANDLER_STEPS, runFault, summarizeFault, type CrashPoint, type FaultResult, type FaultScenario } from "./support/v6-fault.js";
import { assertScenarioEvidence } from "./support/v6-fault-assert.js";

const seedsText = process.env.ZYRON_V6_FAULT_SEEDS;

function parseSeeds(text: string): number[] {
  const range = /^(\d+)-(\d+)$/.exec(text.trim());
  const [from, to] = range ? [Number(range[1]), Number(range[2])] : [1, Number(text)];
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) throw new Error(`Invalid ZYRON_V6_FAULT_SEEDS: ${text}`);
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

type PlanItem = { kind: "scenario"; scenario: FaultScenario; n: number; seed: number } | { kind: "crash-point"; point: CrashPoint; n: number; seed: number };

if (!seedsText) {
  test("P0-03 v6 fault seed sweep (set ZYRON_V6_FAULT_SEEDS to run)", { skip: "ZYRON_V6_FAULT_SEEDS is not set" }, () => {});
} else {
  const seeds = parseSeeds(seedsText);
  const ns = (process.env.ZYRON_V6_FAULT_N ?? "4,7").split(",").map(Number);
  const selected = (process.env.ZYRON_V6_FAULT_SCENARIOS ?? [...FAULT_SCENARIOS, "crash-points"].join(",")).split(",");
  const [shard, shards] = (process.env.ZYRON_V6_FAULT_SHARD ?? "0/1").split("/").map(Number) as [number, number];
  const chaosMs = process.env.ZYRON_V6_FAULT_CHAOS_MS ? Number(process.env.ZYRON_V6_FAULT_CHAOS_MS) : undefined;
  const out = process.env.ZYRON_V6_FAULT_OUT;
  const plan: PlanItem[] = [];
  for (const seed of seeds) {
    for (const n of ns) {
      for (const scenario of FAULT_SCENARIOS) if (selected.includes(scenario)) plan.push({ kind: "scenario", scenario, n, seed });
      if (selected.includes("crash-points")) for (const point of CRASH_POINTS) plan.push({ kind: "crash-point", point, n, seed });
    }
  }
  for (const [position, item] of plan.entries()) {
    if (position % shards !== shard) continue;
    const name = item.kind === "scenario" ? `${item.scenario} n=${item.n} seed=${item.seed}` : `crash-point ${item.point} n=${item.n} seed=${item.seed}`;
    test(`P0-03 v6 fault sweep: ${name}`, { timeout: 900_000 }, async () => {
      const started = Date.now();
      let result: FaultResult;
      if (item.kind === "scenario") {
        result = await runFault({ scenario: item.scenario, n: item.n, seed: item.seed, ...(chaosMs ? { chaosMs } : {}) });
      } else {
        result = await runFault({ scenario: "power-loss", n: item.n, seed: item.seed, chaosMs: chaosMs ?? 300_000, postGstHeights: 3, cover: { point: item.point, steps: HANDLER_STEPS } });
      }
      if (out) await appendFile(out, `${JSON.stringify({ ...item, wallMs: Date.now() - started, result })}\n`);
      if (item.kind === "scenario") {
        assertScenarioEvidence(result);
      } else {
        assert.ok(result.ok, summarizeFault(result));
      }
    });
  }
}
