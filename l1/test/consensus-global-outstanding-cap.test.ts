import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_HTTP_CONSENSUS_OUTSTANDING,
  collectHttpConsensusPeers
} from "../src/node.js";
import {
  MAX_NATIVE_CONSENSUS_OUTSTANDING,
  collectNativeConsensusBounded
} from "../src/p2p-consensus.js";

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

async function fillHttpBudget(started: { value: number }): Promise<void> {
  const peers = Array.from({ length: 8 }, (_, index) => `http-peer-${started.value}-${index}`);
  await collectHttpConsensusPeers(peers, async () => {
    started.value += 1;
    return neverSettles<string>();
  }, 20, 8);
}

async function fillNativeBudget(started: { value: number }): Promise<void> {
  const peers = Array.from({ length: 8 }, (_, index) => `native-peer-${started.value}-${index}`);
  await collectNativeConsensusBounded(peers, async () => {
    started.value += 1;
    return neverSettles<string>();
  }, { timeoutMs: 20, maxConcurrency: 8 });
}

test("HTTP consensus globally bounds detached abort-noncooperative work without waiters", async () => {
  const keepAlive = setInterval(() => undefined, 1_000);
  const started = { value: 0 };
  try {
    while (started.value < MAX_HTTP_CONSENSUS_OUTSTANDING) await fillHttpBudget(started);
    assert.equal(started.value, MAX_HTTP_CONSENSUS_OUTSTANDING);

    const startedAt = Date.now();
    const result = await collectHttpConsensusPeers(["overflow-a", "overflow-b"], async () => {
      started.value += 1;
      return neverSettles<string>();
    }, 40, 2);
    assert.deepEqual(result, []);
    assert.equal(started.value, MAX_HTTP_CONSENSUS_OUTSTANDING);
    assert.ok(Date.now() - startedAt < 250, "HTTP saturation queued instead of failing closed");
  } finally {
    clearInterval(keepAlive);
  }
});

test("native consensus globally bounds detached abort-noncooperative work without waiters", async () => {
  const started = { value: 0 };
  while (started.value < MAX_NATIVE_CONSENSUS_OUTSTANDING) await fillNativeBudget(started);
  assert.equal(started.value, MAX_NATIVE_CONSENSUS_OUTSTANDING);

  const startedAt = Date.now();
  const result = await collectNativeConsensusBounded(["overflow-a", "overflow-b"], async () => {
    started.value += 1;
    return neverSettles<string>();
  }, { timeoutMs: 40, maxConcurrency: 2 });
  assert.equal(started.value, MAX_NATIVE_CONSENSUS_OUTSTANDING);
  assert.equal(result.length, 2);
  assert.ok(result.every((entry) => entry.status === "rejected"));
  assert.ok(Date.now() - startedAt < 250, "native saturation queued instead of failing closed");
});
