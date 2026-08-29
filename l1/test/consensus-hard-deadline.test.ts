import assert from "node:assert/strict";
import test from "node:test";

import { collectHttpConsensusPeers } from "../src/node.js";
import { collectNativeConsensusBounded } from "../src/p2p-consensus.js";

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

test("HTTP consensus hard deadline does not wait for abort-noncooperative requests", async () => {
  const keepAlive = setInterval(() => undefined, 1_000);
  const startedAt = Date.now();
  let started = 0;
  try {
    const result = await collectHttpConsensusPeers(
      ["peer-a", "peer-b", "peer-c", "peer-d"],
      async () => {
        started += 1;
        return neverSettles<string>();
      },
      40,
      2
    );
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(result, []);
    assert.equal(started, 2);
    assert.ok(elapsed < 250, `HTTP consensus hard deadline took ${elapsed}ms`);
  } finally {
    clearInterval(keepAlive);
  }
});

test("native consensus hard deadline rejects started abort-noncooperative requests", async () => {
  const startedAt = Date.now();
  let started = 0;
  const result = await collectNativeConsensusBounded(
    ["peer-a", "peer-b", "peer-c", "peer-d"],
    async () => {
      started += 1;
      return neverSettles<string>();
    },
    { maxConcurrency: 2, timeoutMs: 40 }
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(started, 2);
  assert.equal(result.length, 2);
  assert.ok(result.every((entry) => entry.status === "rejected"));
  assert.ok(elapsed < 250, `native consensus hard deadline took ${elapsed}ms`);
});
