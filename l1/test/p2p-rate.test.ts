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

test("native peer rate limiter routes untracked identities through a bounded shared overflow window", () => {
  const limiter = new P2PPeerRateLimiter(10, 5_000, 2, 2);
  const internals = limiter as unknown as {
    peers: Map<string, unknown>;
    overflowCount: number;
    overflowStartedAtMs: number | null;
  };

  assert.equal(limiter.consume("peer-a", 1_000), true);
  assert.equal(limiter.consume("peer-b", 1_000), true);
  assert.equal(internals.peers.size, 2);

  assert.equal(limiter.consume("peer-c", 1_100), true);
  assert.equal(limiter.consume("peer-d", 1_200), true);
  assert.equal(limiter.consume("peer-e", 1_300), false);
  assert.equal(internals.peers.size, 2);
  assert.equal(internals.overflowCount, 3);
  assert.equal(internals.overflowStartedAtMs, 1_100);

  assert.equal(limiter.consume("peer-a", 1_400), true);
  assert.equal(limiter.consume("peer-b", 1_400), true);
  assert.equal(internals.peers.size, 2);
});

test("native peer overflow quota resets without growing per-untracked-identity state", () => {
  const limiter = new P2PPeerRateLimiter(10, 2_000, 1, 1);
  const internals = limiter as unknown as {
    peers: Map<string, unknown>;
    overflowCount: number;
    overflowStartedAtMs: number | null;
  };

  assert.equal(limiter.consume("tracked", 5_000), true);
  assert.equal(limiter.consume("overflow-a", 5_100), true);
  assert.equal(limiter.consume("overflow-b", 5_200), false);
  assert.equal(internals.peers.size, 1);

  // The original tracked window expires before the overflow window. Fill the
  // newly available tracked slot first so the next unseen identity is forced
  // back through the shared overflow path after that path's own boundary.
  assert.equal(limiter.consume("replacement-tracked", 7_100), true);
  assert.equal(internals.peers.size, 1);
  assert.equal(limiter.consume("overflow-c", 7_200), true);
  assert.equal(internals.peers.size, 1);
  assert.equal(internals.overflowCount, 1);
  assert.equal(internals.overflowStartedAtMs, 7_200);
});

test("native peer limiter never evicts live tracked peers to admit rotating overflow identities", () => {
  const limiter = new P2PPeerRateLimiter(3, 10_000, 2, 3);
  const internals = limiter as unknown as { peers: Map<string, unknown> };

  assert.equal(limiter.consume("peer-a", 1_000), true);
  assert.equal(limiter.consume("peer-b", 1_000), true);
  for (let index = 0; index < 50; index += 1) {
    limiter.consume(`rotating-${index}`, 1_100 + index);
  }

  assert.deepEqual([...internals.peers.keys()].sort(), ["peer-a", "peer-b"]);
  assert.equal(limiter.consume("peer-a", 1_500), true);
  assert.equal(limiter.consume("peer-a", 1_600), true);
  assert.equal(limiter.consume("peer-a", 1_700), false);
});

test("native peer rate limiter does not full-sweep before the earliest expiry", () => {
  const limiter = new P2PPeerRateLimiter(1_000, 5_000, 3, 100);
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
    assert.equal(limiter.consume(`rotating-${index}`, 1_300 + index), index < 100);
  }
  assert.equal(sweeps, 0);

  assert.equal(limiter.consume("peer-d", 6_000), true);
  assert.equal(sweeps, 1);

  for (let index = 0; index < 99; index += 1) {
    assert.equal(limiter.consume(`post-sweep-${index}`, 6_001 + index), false);
  }
  assert.equal(sweeps, 1);

  assert.equal(limiter.consume("peer-e", 6_100), true);
  assert.equal(sweeps, 2);
});
