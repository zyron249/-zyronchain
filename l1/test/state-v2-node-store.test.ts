import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

    const reader = await StateV2NodeObjectStore.open(directory, 2);
    const lazy = SparseMerkleState.fromNodeResolver(original.root(), reader.resolver());
    assert.equal(reader.cachedRecordCount(), 1);
    assert.deepEqual(lazy.get("account:73"), { balanceAtoms: 74, nonce: 0 });
    assert.ok(reader.cachedRecordCount() <= 2);
    assert.equal(lazy.set("account:73", { balanceAtoms: 999, nonce: 1 }).root(),
      original.set("account:73", { balanceAtoms: 999, nonce: 1 }).root());
    assert.ok(reader.cachedRecordCount() <= 2);
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
    const rootPath = join(directory, "state-v2.nodes", root.slice(0, 2), `${root}.json`);
    const envelope = JSON.parse(await readFile(rootPath, "utf8")) as { checksum: string; record: { hash: string } };
    envelope.checksum = "00".repeat(32);
    await writeFile(rootPath, `${JSON.stringify(envelope)}\n`, "utf8");
    const reopened = await StateV2NodeObjectStore.open(directory, 0);
    assert.throws(() => SparseMerkleState.fromNodeResolver(root, reopened.resolver()), /checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
