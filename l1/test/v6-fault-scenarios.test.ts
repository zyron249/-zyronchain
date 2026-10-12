// P0-03: per-PR smoke run of every v6 fault-injection scenario at n = 4
// (split-quorum: q = 3, f = 1), one deterministic seed each. Every run checks
// the invariant set of support/v6-fault.ts; the asserts below add evidence
// that the scenario's faults actually happened. Heavier seed sweeps (n = 2,
// 4, 7): ZYRON_V6_FAULT_SEEDS, see v6-fault-seeds.test.ts.
import assert from "node:assert/strict";
import test from "node:test";

import { FAULT_SCENARIOS, runFault, summarizeFault } from "./support/v6-fault.js";
import { assertScenarioEvidence } from "./support/v6-fault-assert.js";

for (const scenario of FAULT_SCENARIOS) {
  test(`P0-03 v6 fault smoke: ${scenario} (n=4) - safety, journal audit, prefix consistency, supply, bounded liveness after GST`, { timeout: 300_000 }, async () => {
    const result = await runFault({ scenario, n: 4, seed: 1, ...(scenario === "long-run" ? { chaosMs: 1_000_000 } : {}) });
    assertScenarioEvidence(result);
    assert.ok(result.livenessAsserted, summarizeFault(result));
  });
}
