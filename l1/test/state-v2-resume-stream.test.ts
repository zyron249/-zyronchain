import assert from "node:assert/strict";
import test from "node:test";

import {
  streamPortableResumeKeys,
  streamPortableResumeRecords
} from "../src/state-v2-resume-stream.js";
import type { PortableStateResumeStore } from "../src/state-v2-resume.js";

function fakeStore(recordCount: number, keyCount: number, complete = true) {
  const recordCalls: Array<[number, number]> = [];
  const keyCalls: Array<[number, number]> = [];
  const store = {
    manifest: { recordCount, keyCount },
    complete: () => complete,
    records: async (start: number, limit: number) => {
      recordCalls.push([start, limit]);
      return Array.from({ length: limit }, (_, index) => `r${start + index}`);
    },
    keys: async (start: number, limit: number) => {
      keyCalls.push([start, limit]);
      return Array.from({ length: limit }, (_, index) => `k${start + index}`);
    }
  } as unknown as PortableStateResumeStore;
  return { store, recordCalls, keyCalls };
}

test("portable resume record streaming stays within the requested batch size", async () => {
  const { store, recordCalls } = fakeStore(10, 1);
  const batches: unknown[][] = [];
  for await (const batch of streamPortableResumeRecords(store, 4)) batches.push(batch);
  assert.deepEqual(recordCalls, [[0, 4], [4, 4], [8, 2]]);
  assert.deepEqual(batches.map((batch) => batch.length), [4, 4, 2]);
  assert.equal(batches.flat().length, 10);
});

test("portable resume key streaming stays within the requested batch size", async () => {
  const { store, keyCalls } = fakeStore(1, 9);
  const batches: unknown[][] = [];
  for await (const batch of streamPortableResumeKeys(store, 5)) batches.push(batch);
  assert.deepEqual(keyCalls, [[0, 5], [5, 4]]);
  assert.deepEqual(batches.map((batch) => batch.length), [5, 4]);
});

test("portable resume streaming fails closed before reading an incomplete store", async () => {
  const { store, recordCalls, keyCalls } = fakeStore(10, 10, false);
  await assert.rejects(async () => {
    for await (const _batch of streamPortableResumeRecords(store, 4)) void _batch;
  }, /Portable state resume is incomplete/);
  await assert.rejects(async () => {
    for await (const _batch of streamPortableResumeKeys(store, 4)) void _batch;
  }, /Portable state resume is incomplete/);
  assert.deepEqual(recordCalls, []);
  assert.deepEqual(keyCalls, []);
});

test("portable resume streaming rejects invalid batch sizes", async () => {
  const { store } = fakeStore(1, 1);
  await assert.rejects(async () => {
    for await (const _batch of streamPortableResumeRecords(store, 0)) void _batch;
  }, /Invalid portable state record stream batch size/);
  await assert.rejects(async () => {
    for await (const _batch of streamPortableResumeKeys(store, 1_000_001)) void _batch;
  }, /Invalid portable state key stream batch size/);
});
