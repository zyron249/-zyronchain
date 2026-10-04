// F-01 phase 5: T6 (repeated-round-changes-bounded) and a per-PR chaos smoke
// run of every scenario in support/v6-chaos.ts (n = 4, one seed each). The
// many-seed runs (n = 2, 3, 4, 7) are produced by
// /workspace/zyron-dev/f01-work/run-chaos.mjs (chaos-output.txt).
import assert from "node:assert/strict";
import test from "node:test";

import { CHAOS_SCENARIOS, runChaos } from "./support/v6-chaos.js";

test("F-01 v6 T6: n=4 with a crashed validator and random drops before GST; >= 50 rounds, then finality within f+1 rounds", { timeout: 300_000 }, async () => {
  const result = await runChaos({ scenario: "repeated-round-changes", n: 4, seed: 1, dropRate: 0.6, chaosMs: 1_800_000, postGstHeights: 6 });
  assert.equal(result.faulty.startsWith("crashed v"), true);
  assert.ok(result.totalRounds >= 50, `only ${result.totalRounds} rounds`);
  assert.ok(result.rStar >= 10, "the height pending at GST went through repeated round changes");
  assert.equal(result.honestDoubleSigns, 0);
  assert.equal(result.conflictingCertificates, 0);
  assert.equal(result.conflictingFinality, 0);
  assert.equal(result.postGst.length, 6);
  for (const item of result.postGst) assert.ok(item.commitRound <= item.bound, JSON.stringify(item));
  assert.ok(result.livenessOk, result.failure);
  assert.ok(result.ok, result.failure);
});

for (const scenario of CHAOS_SCENARIOS) {
  test(`F-01 v6 chaos smoke: ${scenario} (n=4) - no conflicting finality, no honest double-sign, bounded finality after GST`, { timeout: 300_000 }, async () => {
    const result = await runChaos({ scenario, n: 4, seed: 1, chaosMs: 150_000 });
    assert.equal(result.honestDoubleSigns, 0);
    assert.equal(result.conflictingCertificates, 0);
    assert.equal(result.conflictingFinality, 0);
    if (scenario === "byzantine-equivocation") assert.ok(result.byzantineDoubleSigns > 0, "the byzantine leader did equivocate");
    if (scenario === "restart-while-locked") assert.ok(result.restartsWhileLocked > 0, "some restart happened while locked");
    if (result.livenessAsserted) assert.ok(result.livenessOk, result.failure);
    assert.ok(result.ok, result.failure);
  });
}
