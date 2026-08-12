import assert from "node:assert/strict";
import test from "node:test";

import { FixedWindowLimiter } from "../src/rpc-rate-limit.js";

test("RPC limiter bounds individually tracked identities", () => {
  const limiter = new FixedWindowLimiter(3, 60_000, 2);
  assert.equal(limiter.consume("client-a", 1_000).allowed, true);
  assert.equal(limiter.consume("client-b", 1_000).allowed, true);
  assert.equal(limiter.trackedIdentityCount, 2);

  for (let i = 0; i < 100; i += 1) {
    limiter.consume(`rotating-${i}`, 1_001 + i);
  }

  assert.equal(limiter.trackedIdentityCount, 2);
});

test("unseen identities share one overflow quota after capacity is reached", () => {
  const limiter = new FixedWindowLimiter(2, 60_000, 1);
  assert.equal(limiter.consume("tracked", 10_000).allowed, true);

  const first = limiter.consume("rotating-a", 10_001);
  const second = limiter.consume("rotating-b", 10_002);
  const third = limiter.consume("rotating-c", 10_003);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
  assert.equal(limiter.trackedIdentityCount, 1);
});

test("overflow quota resets only at its fixed-window boundary", () => {
  const limiter = new FixedWindowLimiter(1, 1_000, 1);
  limiter.consume("tracked", 5_000);
  assert.equal(limiter.consume("overflow-a", 5_100).allowed, true);
  assert.equal(limiter.consume("overflow-b", 5_999).allowed, false);
  assert.equal(limiter.consume("overflow-c", 6_100).allowed, true);
});

test("tracked identities retain their own quota while overflow is saturated", () => {
  const limiter = new FixedWindowLimiter(2, 60_000, 1);
  assert.equal(limiter.consume("tracked", 1_000).allowed, true);
  assert.equal(limiter.consume("overflow-a", 1_001).allowed, true);
  assert.equal(limiter.consume("overflow-b", 1_002).allowed, true);
  assert.equal(limiter.consume("overflow-c", 1_003).allowed, false);
  assert.equal(limiter.consume("tracked", 1_004).allowed, true);
  assert.equal(limiter.consume("tracked", 1_005).allowed, false);
});
