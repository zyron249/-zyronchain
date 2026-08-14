import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SparseMerkleState, type StateV2NodeRecord } from "../src/state-v2.js";
import {
  stagePortableResumeRecords,
  stagePortableResumeSemanticKeys
} from "../src/state-v2-resume-stage.js";
import type { PortableStateResumeStore } from "../src/state-v2-resume.js";

function fakeStore(
  root: string,
  records: readonly StateV2NodeRecord[],
  keys: readonly string[] = ["account:placeholder"]
): PortableStateResumeStore {
  return {
    manifest: { stateRoot: root, recordCount: records.length, keyCount: keys.length },
    complete: () => true,
    records: async (start: number, limit: number) => structuredClone(records.slice(start, start + limit)),
    keys: async (start: number, limit: number) => [...keys.slice(start, start + limit)]
  } as unknown as PortableStateResumeStore;
}

async function withTempDir(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "zyron-state-stage-"));
  try { await run(path); }
  finally { await rm(path, { recursive: true, force: true }); }
}

test("portable resume record and semantic staging authenticate one complete root with bounded batches", async () => {
  let state = SparseMerkleState.empty();
  const keys: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    const key = `account:test-${index}`;
    keys.push(key);
    state = state.set(key, { balanceAtoms: index + 1, nonce: index });
  }
  const records = state.nodeRecords();
  const store = fakeStore(state.root(), records, keys);
  await withTempDir(async (path) => {
    const staged = await stagePortableResumeRecords(store, path, 7);
    const completed = await stagePortableResumeSemanticKeys(store, staged, 9);
    try {
      assert.equal(completed.importedRecordCount, records.length);
      assert.equal(completed.importedKeyCount, keys.length);
      assert.equal(completed.nodeObjects.storedNodeCount(), records.length);
      assert.equal(completed.nodeObjects.storedSemanticKeyCount(), keys.length);
      assert.equal(completed.state.root(), state.root());
      assert.deepEqual(completed.nodeObjects.reachableCounts(completed.state, true), {
        nodes: records.length,
        leaves: keys.length
      });
    } finally {
      completed.nodeObjects.close();
    }
  });
});

test("portable resume record staging rejects duplicate hashes without an O(n) JS identity set", async () => {
  const state = SparseMerkleState.empty().set("account:duplicate-test", { balanceAtoms: 1, nonce: 0 });
  const records = state.nodeRecords();
  const duplicated = [...records, structuredClone(records[0]!)];
  await withTempDir(async (path) => {
    await assert.rejects(() => stagePortableResumeRecords(fakeStore(state.root(), duplicated), path, 2), /duplicate node hashes/);
  });
});

test("portable resume record staging rejects valid-looking nodes that are not committed by the anchored root", async () => {
  const committed = SparseMerkleState.empty().set("account:committed", { balanceAtoms: 2, nonce: 0 });
  const unrelated = SparseMerkleState.empty().set("account:unrelated", { balanceAtoms: 3, nonce: 0 });
  const committedRecords = committed.nodeRecords();
  const committedHashes = new Set(committedRecords.map((record) => record.hash));
  const extra = unrelated.nodeRecords().find((record) => !committedHashes.has(record.hash));
  assert.ok(extra);
  const records = [...committedRecords, structuredClone(extra)];
  await withTempDir(async (path) => {
    await assert.rejects(() => stagePortableResumeRecords(fakeStore(committed.root(), records), path, 3), /unreachable or uncommitted nodes/);
  });
});

test("portable resume record staging rejects malformed records before durable root validation", async () => {
  const state = SparseMerkleState.empty().set("account:malformed", { balanceAtoms: 4, nonce: 0 });
  const records = state.nodeRecords().map((record) => structuredClone(record)) as Array<StateV2NodeRecord | Record<string, unknown>>;
  records[0] = { ...records[0], unexpected: true };
  await withTempDir(async (path) => {
    await assert.rejects(
      () => stagePortableResumeRecords(fakeStore(state.root(), records as StateV2NodeRecord[]), path, 4),
      /Invalid portable State v2/
    );
  });
});

test("portable semantic staging rejects duplicate preimages across bounded batches", async () => {
  const key = "account:semantic-duplicate";
  const state = SparseMerkleState.empty().set(key, { balanceAtoms: 5, nonce: 0 });
  const store = fakeStore(state.root(), state.nodeRecords(), [key, key]);
  await withTempDir(async (path) => {
    const staged = await stagePortableResumeRecords(store, path, 4);
    await assert.rejects(() => stagePortableResumeSemanticKeys(store, staged, 1), /duplicate key preimages/);
  });
});

test("portable semantic staging rejects an extra uncommitted preimage", async () => {
  const key = "account:semantic-committed";
  const state = SparseMerkleState.empty().set(key, { balanceAtoms: 6, nonce: 0 });
  const store = fakeStore(state.root(), state.nodeRecords(), [key, "account:not-committed"]);
  await withTempDir(async (path) => {
    const staged = await stagePortableResumeRecords(store, path, 4);
    await assert.rejects(() => stagePortableResumeSemanticKeys(store, staged, 2), /extra or incomplete key preimages/);
  });
});

test("portable semantic staging rejects a missing committed preimage", async () => {
  const first = "account:semantic-first";
  const second = "account:semantic-second";
  const state = SparseMerkleState.empty()
    .set(first, { balanceAtoms: 7, nonce: 0 })
    .set(second, { balanceAtoms: 8, nonce: 0 });
  const store = fakeStore(state.root(), state.nodeRecords(), [first]);
  await withTempDir(async (path) => {
    const staged = await stagePortableResumeRecords(store, path, 4);
    await assert.rejects(
      () => stagePortableResumeSemanticKeys(store, staged, 1),
      /Incomplete persisted State v2 semantic key index/
    );
  });
});
