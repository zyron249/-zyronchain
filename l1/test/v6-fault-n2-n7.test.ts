// P0-03: functional n = 2 (q = 2, no fault tolerance: any fault halts until
// it heals) and multi-operator n = 7 (q = 5, f = 2) smoke runs of selected
// v6 fault scenarios. Same invariants as v6-fault-scenarios.test.ts.
import test from "node:test";

import { runFault, type FaultScenario } from "./support/v6-fault.js";
import { assertScenarioEvidence } from "./support/v6-fault-assert.js";

const CASES: Array<[number, FaultScenario, number?]> = [
  [2, "crash-step"],
  [2, "power-loss"],
  [2, "partition-flapping"],
  [2, "delay-reorder-duplicate"],
  [2, "upgrade-v5-v6"],
  [7, "byzantine-f", 180_000],
  [7, "combined", 240_000],
  [7, "prolonged-outage-sync", 450_000]
];

for (const [n, scenario, chaosMs] of CASES) {
  test(`P0-03 v6 fault smoke: ${scenario} (n=${n})`, { timeout: 300_000 }, async () => {
    assertScenarioEvidence(await runFault({ scenario, n, seed: 1, ...(chaosMs ? { chaosMs } : {}) }));
  });
}
