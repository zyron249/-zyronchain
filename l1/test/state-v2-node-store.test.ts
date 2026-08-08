import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { StateV2NodeObjectStore } from "../src/state-v2-node-store.js";
import { SparseMerkleState } from "../src/state-v2.js";

test("State v2 object store resolves authenticated state with a bounded cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-objects-"));
  try {
    let original = SparseMerkleState.empty();
    for (let index = 0; index < 128; index += 1) {
      original = original.set(`account:${index}`, { balanceAtoms: index + 1, nonce: 0 });
    }
    const records = original.nodeRecords();
    assert.ok(records.length > 8);

    const writer = await StateV2NodeObjectStore.open(directory, 2);
    await writer.putMany(records);
    assert.ok(writer.cachedRecordCount() <= 2);
    writer.close();

    const reader = await StateV2NodeObjectStore.open(directory, 2);
    const lazy = SparseMerkleState.fromNodeResolver(original.root(), reader.resolver());
    assert.equal(reader.cachedRecordCount(), 1);
    assert.deepEqual(lazy.get("account:73"), { balanceAtoms: 74, nonce: 0 });
    assert.ok(reader.cachedRecordCount() <= 2);
    assert.equal(lazy.set("account:73", { balanceAtoms: 999, nonce: 1 }).root(),
      original.set("account:73", { balanceAtoms: 999, nonce: 1 }).root());
    assert.ok(reader.cachedRecordCount() <= 2);
    reader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 object store rejects missing, path-substituted and checksum-corrupt records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-objects-corrupt-"));
  try {
    const state = SparseMerkleState.empty()
      .set("account:alice", { balanceAtoms: 10, nonce: 0 })
      .set("account:bob", { balanceAtoms: 20, nonce: 0 });
    const store = await StateV2NodeObjectStore.open(directory, 0);
    await store.putMany(state.nodeRecords());
    assert.equal(store.get("11".repeat(32)), undefined);
    assert.throws(() => store.get("../escape"), /Invalid State v2 node hash/);

    const root = state.root();
    store.close();
    const database = new Database(join(directory, "state-v2.nodes.sqlite"));
    database.prepare("UPDATE nodes SET checksum = ? WHERE hash = ?").run("00".repeat(32), root);
    database.close();
    const reopened = await StateV2NodeObjectStore.open(directory, 0);
    assert.throws(() => SparseMerkleState.fromNodeResolver(root, reopened.resolver()), /checksum mismatch/);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 object-store batch rolls back atomically on a conflicting content hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-objects-rollback-"));
  try {
    const base = SparseMerkleState.empty().set("account:alice", { balanceAtoms: 10, nonce: 0 });
    const store = await StateV2NodeObjectStore.open(directory, 0);
    await store.putMany(base.nodeRecords());
    const next = base.set("account:bob", { balanceAtoms: 20, nonce: 0 });
    const fresh = next.pendingNodeRecords().find((record) => store.get(record.hash) === undefined)!;
    const existing = base.nodeRecords()[0]!;
    const conflicting = existing.kind === "leaf"
      ? { ...existing, valueJson: `${existing.valueJson} ` }
      : { ...existing, leftHash: existing.leftHash === null ? "00".repeat(32) : null };

    await assert.rejects(() => store.putMany([fresh, conflicting]), /Conflicting persisted State v2 node object/);
    assert.equal(store.get(fresh.hash), undefined, "transaction must roll back earlier inserts in the same batch");
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
