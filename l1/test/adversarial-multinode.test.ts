import assert from "node:assert/strict";
import test from "node:test";

import { runAdversarialHarness } from "../bench/adversarial-multinode.js";

test("seeded adversarial multi-node schedule is deterministic and preserves safety through healing", () => {
  const first = runAdversarialHarness({ steps: 247, seed: 0x5a17_2026 });
  const second = runAdversarialHarness({ steps: 247, seed: 0x5a17_2026 });

  assert.deepEqual(second, first);
  assert.equal(first.finalizedHeight, 247);
  assert.ok(first.faultEvents.quorumLossStalls > 0);
  assert.ok(first.faultEvents.proposerFailures > 0);
  assert.ok(first.faultEvents.isolatedDeliveries > 0);
  assert.ok(first.faultEvents.crashReplays > 0);
  assert.ok(first.faultEvents.equivocationRejections > 0);
  assert.deepEqual(first.invariants, {
    conflictingFinalityObserved: false,
    allNodesConverged: true,
    replayConverged: true
  });
});

test("adversarial multi-node harness rejects unsafe or unbounded run parameters", () => {
  assert.throws(() => runAdversarialHarness({ steps: 0, seed: 1 }), /steps/);
  assert.throws(() => runAdversarialHarness({ steps: 1_000_001, seed: 1 }), /steps/);
  assert.throws(() => runAdversarialHarness({ steps: 1, seed: 0 }), /seed/);
});
