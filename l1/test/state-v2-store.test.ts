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
    await store.commit(first);
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

test("State v2 disk store ignores an unterminated crash tail after a committed root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-tail-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    const state = store.state().set("account:alice", { balanceAtoms: 5, nonce: 1 });
    await store.commit(state);
    await appendFile(join(directory, "state-v2.nodes.ndjson"), "{partial-crash-tail", "utf8");
    const reopened = await StateV2DiskStore.open(directory);
    assert.equal(reopened.state().root(), state.root());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State v2 disk store fails closed on checksum corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-corrupt-"));
  try {
    const store = await StateV2DiskStore.open(directory);
    await store.commit(store.state().set("account:alice", { balanceAtoms: 5, nonce: 1 }));
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
