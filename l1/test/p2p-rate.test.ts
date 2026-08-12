import assert from "node:assert/strict";
import test from "node:test";

import { P2PPeerRateLimiter } from "../src/p2p-rate.js";

test("native peer rate limiter bounds repeated identities and resets by window", () => {
  const limiter = new P2PPeerRateLimiter(2, 1_000, 4);
  assert.equal(limiter.consume("peer-a", 10_000), true);
  assert.equal(limiter.consume("peer-a", 10_100), true);
  assert.equal(limiter.consume("peer-a", 10_200), false);
  assert.equal(limiter.consume("peer-b", 10_200), true);
  assert.equal(limiter.consume("peer-a", 11_000), true);
});

test("native peer rate limiter fails closed at bounded identity capacity", () => {
  const limiter = new P2PPeerRateLimiter(10, 5_000, 2);
  assert.equal(limiter.consume("peer-a", 1_000), true);
  assert.equal(limiter.consume("peer-b", 1_000), true);
  assert.equal(limiter.consume("peer-c", 1_000), false);
  assert.equal(limiter.consume("peer-c", 6_000), true);
});

test("native peer rate limiter does not full-sweep before the earliest expiry", () => {
  const limiter = new P2PPeerRateLimiter(1_000, 5_000, 3);
  const internals = limiter as unknown as { sweep(nowMs: number): void };
  const originalSweep = internals.sweep.bind(limiter);
  let sweeps = 0;
  internals.sweep = (nowMs: number) => {
    sweeps += 1;
    originalSweep(nowMs);
  };

  assert.equal(limiter.consume("peer-a", 1_000), true);
  assert.equal(limiter.consume("peer-b", 1_100), true);
  assert.equal(limiter.consume("peer-c", 1_200), true);

  for (let index = 0; index < 200; index += 1) {
    assert.equal(limiter.consume("peer-a", 1_300 + index), true);
    assert.equal(limiter.consume(`rotating-${index}`, 1_300 + index), false);
  }
  assert.equal(sweeps, 0);

  assert.equal(limiter.consume("peer-d", 6_000), true);
  assert.equal(sweeps, 1);

  for (let index = 0; index < 100; index += 1) {
    assert.equal(limiter.consume(`post-sweep-${index}`, 6_001 + index), false);
  }
  assert.equal(sweeps, 1);
});
