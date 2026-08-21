import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CHECKPOINT_CACHE_BYTES,
  retainCheckpointCacheEntry
} from "../src/p2p-checkpoint.js";

interface FakeSnapshot {
  bytes: Buffer;
}

function retainedBytes(cache: Map<string, FakeSnapshot>): number {
  let total = 0;
  for (const value of cache.values()) total += value.bytes.length;
  return total;
}

test("checkpoint serving cache retains two small snapshots within aggregate bound", () => {
  const cache = new Map<string, FakeSnapshot>();
  retainCheckpointCacheEntry(cache, "a", { bytes: Buffer.alloc(16) }, 64, 2);
  retainCheckpointCacheEntry(cache, "b", { bytes: Buffer.alloc(24) }, 64, 2);
  assert.deepEqual([...cache.keys()], ["a", "b"]);
  assert.equal(retainedBytes(cache), 40);
});

test("checkpoint serving cache evicts oldest entry before exceeding aggregate bytes", () => {
  const cache = new Map<string, FakeSnapshot>();
  retainCheckpointCacheEntry(cache, "a", { bytes: Buffer.alloc(40) }, 64, 2);
  retainCheckpointCacheEntry(cache, "b", { bytes: Buffer.alloc(20) }, 64, 2);
  retainCheckpointCacheEntry(cache, "c", { bytes: Buffer.alloc(48) }, 64, 2);
  assert.deepEqual([...cache.keys()], ["c"]);
  assert.equal(retainedBytes(cache), 48);
});

test("checkpoint serving cache never admits an entry above its byte ceiling", () => {
  const cache = new Map<string, FakeSnapshot>();
  assert.throws(
    () => retainCheckpointCacheEntry(cache, "oversized", { bytes: Buffer.alloc(65) }, 64, 2),
    /Invalid checkpoint cache bounds/
  );
  assert.equal(cache.size, 0);
});

test("production checkpoint cache ceiling is no larger than one canonical snapshot", () => {
  assert.equal(MAX_CHECKPOINT_CACHE_BYTES, 64 * 1024 * 1024);
});
