import assert from "node:assert/strict";
import test from "node:test";

import { collectNativeConsensusBounded } from "../src/p2p-consensus.js";

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

test("native consensus collection never exceeds its outbound concurrency budget", async () => {
  let active = 0;
  let maxActive = 0;
  const targets = Array.from({ length: 19 }, (_, index) => index);

  const results = await collectNativeConsensusBounded(targets, async (target, signal) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await abortableDelay(5, signal);
      return target;
    } finally {
      active -= 1;
    }
  }, { maxConcurrency: 3, timeoutMs: 1_000 });

  assert.equal(maxActive, 3);
  assert.equal(active, 0);
  assert.equal(results.length, targets.length);
  assert.deepEqual(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []), targets);
});

test("native consensus collection shares one deadline and retains fast valid results", async () => {
  const startedAt = Date.now();
  const targets = ["slow-a", "fast", "slow-b", "slow-c"];

  const results = await collectNativeConsensusBounded(targets, async (target, signal, deadlineMs) => {
    assert.ok(deadlineMs >= startedAt);
    if (target === "fast") {
      await abortableDelay(5, signal);
      return target;
    }
    await abortableDelay(5_000, signal);
    return target;
  }, { maxConcurrency: 2, timeoutMs: 50 });

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 500, `collection exceeded bounded deadline window: ${elapsed}ms`);
  assert.ok(results.some((result) => result.status === "fulfilled" && result.value === "fast"));
  assert.ok(results.some((result) => result.status === "rejected"));
});