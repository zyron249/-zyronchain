import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeCheckpointSnapshotSingleFlight,
  type CachedSnapshot,
  type CheckpointMaterializationState
} from "../src/p2p-checkpoint.js";

function candidate(tipHash: string, fill = 1): CachedSnapshot {
  return {
    tipHash,
    snapshotSha256: fill.toString(16).padStart(64, "0"),
    height: fill,
    bytes: Buffer.alloc(16, fill)
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("checkpoint materialization joins concurrent requests for the same finalized tip", async () => {
  const cache = new Map<string, CachedSnapshot>();
  const state: CheckpointMaterializationState = {};
  const gate = deferred();
  const tipHash = "11".repeat(32);
  let calls = 0;
  const materialize = async () => {
    calls += 1;
    await gate.promise;
    return candidate(tipHash);
  };

  const first = materializeCheckpointSnapshotSingleFlight(cache, state, tipHash, materialize);
  await Promise.resolve();
  const second = materializeCheckpointSnapshotSingleFlight(cache, state, tipHash, materialize);
  assert.equal(calls, 1);
  gate.resolve();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(cache.get(tipHash), a);
  assert.equal(state.promise, undefined);
  assert.equal(state.tipHash, undefined);
});

test("checkpoint materialization rejects a different tip while one large build is in flight", async () => {
  const cache = new Map<string, CachedSnapshot>();
  const state: CheckpointMaterializationState = {};
  const gate = deferred();
  const firstTip = "22".repeat(32);
  const secondTip = "33".repeat(32);

  const first = materializeCheckpointSnapshotSingleFlight(cache, state, firstTip, async () => {
    await gate.promise;
    return candidate(firstTip, 2);
  });
  await Promise.resolve();
  await assert.rejects(
    () => materializeCheckpointSnapshotSingleFlight(cache, state, secondTip, () => candidate(secondTip, 3)),
    /materialization already in progress/
  );
  gate.resolve();
  await first;
  assert.equal(cache.has(secondTip), false);
});

test("checkpoint materialization failure clears the single-flight slot for a clean retry", async () => {
  const cache = new Map<string, CachedSnapshot>();
  const state: CheckpointMaterializationState = {};
  const tipHash = "44".repeat(32);

  await assert.rejects(
    () => materializeCheckpointSnapshotSingleFlight(cache, state, tipHash, () => {
      throw new Error("synthetic materialization failure");
    }),
    /synthetic materialization failure/
  );
  assert.equal(state.promise, undefined);
  assert.equal(state.tipHash, undefined);

  const recovered = await materializeCheckpointSnapshotSingleFlight(cache, state, tipHash, () => candidate(tipHash, 4));
  assert.equal(cache.get(tipHash), recovered);
});

test("checkpoint materialization reuses the retained cache without invoking a new builder", async () => {
  const tipHash = "55".repeat(32);
  const retained = candidate(tipHash, 5);
  const cache = new Map<string, CachedSnapshot>([[tipHash, retained]]);
  const state: CheckpointMaterializationState = {};
  let calls = 0;

  const result = await materializeCheckpointSnapshotSingleFlight(cache, state, tipHash, () => {
    calls += 1;
    return candidate(tipHash, 6);
  });
  assert.equal(result, retained);
  assert.equal(calls, 0);
});

test("checkpoint materialization rejects a candidate whose tip changed during serialization", async () => {
  const requestedTip = "66".repeat(32);
  const cache = new Map<string, CachedSnapshot>();
  const state: CheckpointMaterializationState = {};

  await assert.rejects(
    () => materializeCheckpointSnapshotSingleFlight(cache, state, requestedTip, () => candidate("77".repeat(32), 7)),
    /tip changed during materialization/
  );
  assert.equal(cache.size, 0);
  assert.equal(state.promise, undefined);
});
