// P0-03: shared assertions for v6 fault-injection runs (smoke and seed sweeps).
import assert from "node:assert/strict";

import { summarizeFault, type FaultResult, type FaultScenario } from "./v6-fault.js";

/** Scenario evidence (the faults happened) plus the full invariant set. */
export function assertScenarioEvidence(result: FaultResult): void {
  const summary = summarizeFault(result);
  switch (result.scenario as FaultScenario) {
    case "crash-step":
    case "power-loss":
      assert.ok(result.crashes.length + result.idleCrashes > 0 && result.restarts > 0, summary);
      break;
    case "partition-flapping":
      assert.ok(result.linkChanges >= 20, summary);
      break;
    case "delay-reorder-duplicate":
      assert.ok(result.delayed > 0 && result.duplicated > 0 && result.replayed > 0, summary);
      break;
    case "disconnect-reconnect":
      assert.ok(result.disconnects > 0, summary);
      break;
    case "prolonged-outage-sync":
      assert.ok(result.heightsBeforeGst >= 10 || result.n === 2, summary);
      assert.ok(result.restarts >= 1, summary);
      break;
    case "byzantine-f":
      if (result.f > 0) {
        assert.equal(result.byzantine.length, result.f, summary);
        assert.ok(result.byzantineDoubleSigns > 0, `the byzantine validators did equivocate: ${summary}`);
      }
      break;
    case "long-run":
      assert.ok(result.heightsFinalized >= 30, summary);
      break;
    case "upgrade-v5-v6":
      assert.ok(result.lateJoins >= 1, summary);
      assert.ok(result.heightsFinalized >= 4, summary);
      break;
    case "combined":
      assert.ok(result.crashes.length + result.idleCrashes > 0 && result.linkChanges > 0, summary);
      break;
  }
  assert.equal(result.honestDoubleSigns, 0, summary);
  assert.equal(result.conflictingCertificates, 0, summary);
  assert.equal(result.conflictingFinality, 0, summary);
  assert.deepEqual(result.unjournaledSignatures, [], summary);
  assert.deepEqual(result.journalViolations, [], summary);
  assert.deepEqual(result.prefixViolations, [], summary);
  assert.deepEqual(result.upgradeViolations, [], summary);
  assert.ok(result.supply.ok, summary);
  if (result.livenessAsserted) assert.ok(result.livenessOk, summary);
  assert.ok(result.ok, summary);
}
