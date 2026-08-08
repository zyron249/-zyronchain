import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SparseMerkleState } from "../src/state-v2.js";
import { StateV2DiskStore } from "../src/state-v2-store.js";

test("State v2 disk store atomically reopens committed node/value state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-store-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    const first = store.state()
      .set("account:alice", { balanceAtoms: 100, nonce: 1 })
      .set("activity-epoch:7", { settled: true });
    await store.commit(first, ["account:alice", "activity-epoch:7"]);
    const reopened = await StateV2DiskStore.open(directory);
    assert.equal(reopened.state().root(), first.root());
    assert.deepEqual(reopened.state().get("account:alice"), { balanceAtoms: 100, nonce: 1 });

    const second = reopened.state().set("account:alice", { balanceAtoms: 75, nonce: 2 });
    await reopened.commit(second);
    const reopenedAgain = await StateV2DiskStore.open(directory);
    assert.equal(reopenedAgain.state().root(), second.root());
    assert.deepEqual(reopenedAgain.state().get("account:alice"), { balanceAtoms: 75, nonce: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 persistence tracks only changed Merkle paths after a checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-delta-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    let state = store.state();
    for (let index = 0; index < 2_000; index += 1) {
      state = state.set(`account:${index}`, { balanceAtoms: index, nonce: 0 });
    }
    await store.commit(state, Array.from({ length: 2_000 }, (_, index) => `account:${index}`));

    const checkpoint = store.state();
    assert.equal(checkpoint.pendingNodeRecords().length, 0);
    const updated = checkpoint.set("account:1000", { balanceAtoms: 999, nonce: 1 });
    assert.ok(updated.pendingNodeRecords().length > 0);
    assert.ok(updated.pendingNodeRecords().length <= 257);
    await store.commit(updated);

    const reopened = await StateV2DiskStore.open(directory);
    assert.equal(reopened.state().root(), updated.root());
    assert.deepEqual(reopened.state().get("account:1000"), { balanceAtoms: 999, nonce: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 disk store ignores an unterminated crash tail after a committed root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-tail-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    const state = store.state().set("account:alice", { balanceAtoms: 5, nonce: 1 });
    await store.commit(state, ["account:alice"]);
    await appendFile(join(directory, "state-v2.nodes.ndjson"), "{partial-crash-tail", "utf8");
    const reopened = await StateV2DiskStore.open(directory);
    assert.equal(reopened.state().root(), state.root());
    const next = reopened.state().set("account:bob", { balanceAtoms: 7, nonce: 0 });
    await reopened.commit(next, ["account:bob"]);
    assert.equal((await StateV2DiskStore.open(directory)).state().root(), next.root());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 store bounds resident historical records and compacts exact duplicate history on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-resident-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    let state = store.state().set("account:alice", { balanceAtoms: 1, nonce: 0 });
    const firstRoot = state.root();
    await store.commit(state, ["account:alice"]);
    for (let balance = 2; balance <= 20; balance += 1) {
      state = state.set("account:alice", { balanceAtoms: balance, nonce: 0 });
      await store.commit(state);
      assert.equal(store.residentNodeRecordCount(), state.nodeRecords().length);
    }
    // Returning to a historical content hash may append an exact duplicate
    // after that old record has left the resident set. Duplicate bytes are safe
    // and are collapsed by verified startup compaction.
    state = state.set("account:alice", { balanceAtoms: 1, nonce: 0 });
    assert.equal(state.root(), firstRoot);
    await store.commit(state);
    const linesBefore = (await readFile(join(directory, "state-v2.nodes.ndjson"), "utf8")).trim().split("\n").length;
    assert.ok(linesBefore > state.nodeRecords().length);

    const reopened = await StateV2DiskStore.open(directory);
    assert.equal(reopened.state().root(), firstRoot);
    assert.equal(reopened.residentNodeRecordCount(), reopened.state().nodeRecords().length);
    const linesAfter = (await readFile(join(directory, "state-v2.nodes.ndjson"), "utf8")).trim().split("\n").length;
    assert.equal(linesAfter, reopened.state().nodeRecords().length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 disk store fails closed on checksum corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-corrupt-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    await store.commit(store.state().set("account:alice", { balanceAtoms: 5, nonce: 1 }), ["account:alice"]);
    const path = join(directory, "state-v2.nodes.ndjson");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const envelope = JSON.parse(lines[0]!) as { checksum: string };
    envelope.checksum = "00".repeat(32);
    lines[0] = JSON.stringify(envelope);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    await assert.rejects(() => StateV2DiskStore.open(directory), /checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 disk store fails closed when the committed root references a missing node", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-missing-node-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    const committed = store.state()
      .set("account:alice", { balanceAtoms: 5, nonce: 1 })
      .set("account:bob", { balanceAtoms: 7, nonce: 2 });
    await store.commit(committed, ["account:alice", "account:bob"]);

    const rootMetadata = JSON.parse(await readFile(join(directory, "state-v2.root.json"), "utf8")) as {
      root: string;
    };
    const nodesPath = join(directory, "state-v2.nodes.ndjson");
    const lines = (await readFile(nodesPath, "utf8")).trimEnd().split("\n");
    const withoutCommittedRoot = lines.filter((line) => {
      const envelope = JSON.parse(line) as { record?: { hash?: string } };
      return envelope.record?.hash !== rootMetadata.root;
    });
    assert.equal(withoutCommittedRoot.length, lines.length - 1);
    await writeFile(nodesPath, `${withoutCommittedRoot.join("\n")}\n`, "utf8");

    await assert.rejects(() => StateV2DiskStore.open(directory), /Missing State v2 node record/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 semantic key index is durable, complete, and ignores pre-root crash orphans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-keys-crash-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    const first = store.state().set("account:alice", { balanceAtoms: 5, nonce: 1 });
    await store.commit(first, ["account:alice"]);
    const second = first.set("account:bob", { balanceAtoms: 7, nonce: 0 });
    await assert.rejects(
      () => store.commit(second, ["account:bob"], {
        afterSemanticKeysSync: () => { throw new Error("injected crash before root commit"); }
      }),
      /injected crash/
    );

    const reopened = await StateV2DiskStore.open(directory);
    assert.equal(reopened.state().root(), first.root());
    assert.deepEqual(reopened.semanticKeyPreimages(), ["account:alice"]);
    assert.equal(reopened.semanticIndexWouldBeComplete(second, []), true);
    await reopened.commit(second);
    assert.equal((await StateV2DiskStore.open(directory)).state().root(), second.root());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 semantic key index fails closed on checksum corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-keys-corrupt-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    await store.commit(store.state().set("account:alice", { balanceAtoms: 5, nonce: 1 }), ["account:alice"]);
    const path = join(directory, "state-v2.keys.ndjson");
    const envelope = JSON.parse((await readFile(path, "utf8")).trim()) as { key: string; checksum: string };
    envelope.checksum = "00".repeat(32);
    await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");
    await assert.rejects(() => StateV2DiskStore.open(directory), /semantic key checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
