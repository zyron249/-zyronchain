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
