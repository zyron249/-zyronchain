import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SparseMerkleState, type StateV2NodeRecord } from "../src/state-v2.js";
import { stagePortableResumeRecords } from "../src/state-v2-resume-stage.js";
import type { PortableStateResumeStore } from "../src/state-v2-resume.js";

function fakeStore(root: string, records: readonly StateV2NodeRecord[]): PortableStateResumeStore {
  return {
    manifest: {
      stateRoot: root,
      recordCount: records.length,
      keyCount: 1
    },
    complete: () => true,
    records: async (start: number, limit: number) => structuredClone(records.slice(start, start + limit))
  } as unknown as PortableStateResumeStore;
}

async function withTempDir(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "zyron-state-stage-"));
  try { await run(path); }
  finally { await rm(path, { recursive: true, force: true }); }
}

test("portable resume record staging authenticates one complete root with bounded batches", async () => {
  let state = SparseMerkleState.empty();
  for (let index = 0; index < 40; index += 1) {
    state = state.set(`account:test-${index}`, { balanceAtoms: index + 1, nonce: index });
  }
  const records = state.nodeRecords();
  await withTempDir(async (path) => {
    const staged = await stagePortableResumeRecords(fakeStore(state.root(), records), path, 7);
    try {
      assert.equal(staged.importedRecordCount, records.length);
      assert.equal(staged.nodeObjects.storedNodeCount(), records.length);
      assert.equal(staged.state.root(), state.root());
      assert.equal(staged.nodeObjects.reachableNodeCount(staged.state), records.length);
    } finally {
      staged.nodeObjects.close();
    }
  });
});

test("portable resume record staging rejects duplicate hashes without an O(n) JS identity set", async () => {
  const state = SparseMerkleState.empty().set("account:duplicate-test", { balanceAtoms: 1, nonce: 0 });
  const records = state.nodeRecords();
  const duplicated = [...records, structuredClone(records[0]!)];
  await withTempDir(async (path) => {
    await assert.rejects(
      () => stagePortableResumeRecords(fakeStore(state.root(), duplicated), path, 2),
      /duplicate node hashes/
    );
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
    await assert.rejects(
      () => stagePortableResumeRecords(fakeStore(committed.root(), records), path, 3),
      /unreachable or uncommitted nodes/
    );
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
