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

test("native peer rate limiter uses one bounded shared overflow quota at identity capacity", () => {
  const limiter = new P2PPeerRateLimiter(10, 5_000, 2, 2);
  const internals = limiter as unknown as { peers: Map<string, unknown> };

  assert.equal(limiter.consume("peer-a", 1_000), true);
  assert.equal(limiter.consume("peer-b", 1_000), true);
  assert.equal(internals.peers.size, 2);

  assert.equal(limiter.consume("peer-c", 1_100), true);
  assert.equal(limiter.consume("peer-d", 1_200), true);
  assert.equal(limiter.consume("peer-e", 1_300), false);
  assert.equal(limiter.consume("peer-f", 1_400), false);
  assert.equal(internals.peers.size, 2);

  // Overflow saturation never steals or resets an already tracked peer's quota.
  assert.equal(limiter.consume("peer-a", 1_500), true);
  assert.equal(internals.peers.size, 2);
});

test("native peer overflow quota resets by fixed window without growing tracked state", () => {
  const limiter = new P2PPeerRateLimiter(10, 5_000, 1, 1);
  const internals = limiter as unknown as { peers: Map<string, unknown> };

  assert.equal(limiter.consume("peer-a", 1_000), true);
  assert.equal(limiter.consume("overflow-a", 1_100), true);
  assert.equal(limiter.consume("overflow-b", 1_200), false);
  assert.equal(internals.peers.size, 1);

  // The tracked peer expires first; a fresh peer takes that one tracked slot.
  assert.equal(limiter.consume("peer-b", 6_000), true);
  assert.equal(internals.peers.size, 1);

  // The prior shared overflow window has also expired, so exactly one new
  // untracked request is admitted before the shared overflow fails closed again.
  assert.equal(limiter.consume("overflow-c", 6_100), true);
  assert.equal(limiter.consume("overflow-d", 6_200), false);
  assert.equal(internals.peers.size, 1);
});

test("native peer rate limiter does not full-sweep before the earliest expiry", () => {
  const limiter = new P2PPeerRateLimiter(1_000, 5_000, 3, 1);
  const internals = limiter as unknown as { sweep(nowMs: number): void; peers: Map<string, unknown> };
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
    assert.equal(limiter.consume(`rotating-${index}`, 1_300 + index), index === 0);
  }
  assert.equal(sweeps, 0);
  assert.equal(internals.peers.size, 3);

  assert.equal(limiter.consume("peer-d", 6_000), true);
  assert.equal(sweeps, 1);

  for (let index = 0; index < 99; index += 1) {
    assert.equal(limiter.consume(`post-sweep-${index}`, 6_001 + index), index === 0);
  }
  assert.equal(sweeps, 1);
  assert.equal(internals.peers.size, 3);

  assert.equal(limiter.consume("peer-e", 6_100), true);
  assert.equal(sweeps, 2);
});
