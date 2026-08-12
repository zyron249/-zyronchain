import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { SparseMerkleState } from "../src/state-v2.js";
import { StateV2DiskStore } from "../src/state-v2-store.js";

function nodeLine(record: ReturnType<SparseMerkleState["nodeRecords"]>[number]): string {
  return canonicalJson({ record, checksum: sha256Hex(canonicalJson(record)) });
}

function keyLine(key: string): string {
  const body = { key };
  return canonicalJson({ ...body, checksum: sha256Hex(canonicalJson(body)) });
}

async function writeLegacyRoot(directory: string, state: SparseMerkleState): Promise<void> {
  const body = { version: 1, root: state.root() } as const;
  await writeFile(
    join(directory, "state-v2.root.json"),
    `${canonicalJson({ ...body, checksum: sha256Hex(canonicalJson(body)) })}\n`,
    { mode: 0o600 }
  );
}

test("legacy State-v2 migration preserves a multi-record authenticated root and semantic index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-stream-migrate-"));
  try {
    let state = SparseMerkleState.empty();
    const keys: string[] = [];
    for (let index = 0; index < 1_200; index += 1) {
      const key = `account:legacy:${index.toString().padStart(4, "0")}`;
      keys.push(key);
      state = state.set(key, { balanceAtoms: index + 1, nonce: index % 7 });
    }
    const records = state.nodeRecords();
    await writeFile(join(directory, "state-v2.nodes.ndjson"), `${records.map(nodeLine).join("\n")}\n`, { mode: 0o600 });
    await writeLegacyRoot(directory, state);
    await writeFile(join(directory, "state-v2.keys.ndjson"), `${keys.map(keyLine).join("\n")}\n`, { mode: 0o600 });

    const migrated = await StateV2DiskStore.open(directory);
    assert.equal(migrated.state().root(), state.root());
    assert.deepEqual(migrated.state().get("account:legacy:0777"), { balanceAtoms: 778, nonce: 0 });
    assert.deepEqual(migrated.semanticKeyPreimages(), [...keys].sort());
    assert.ok(migrated.residentNodeRecordCount() <= 4_096);

    const backend = JSON.parse(await readFile(join(directory, "state-v2.backend.json"), "utf8")) as { backend: string };
    const semantic = JSON.parse(await readFile(join(directory, "state-v2.keys.backend.json"), "utf8")) as { backend: string };
    assert.equal(backend.backend, "sqlite-v1");
    assert.equal(semantic.backend, "sqlite-semantic-v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy State-v2 migration rejects an oversized newline-terminated node record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-stream-node-limit-"));
  try {
    await writeFile(join(directory, "state-v2.nodes.ndjson"), `${"x".repeat((64 * 1024) + 1)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => StateV2DiskStore.open(directory),
      /State v2 legacy node line exceeds 65536 byte limit/
    );
    await assert.rejects(() => readFile(join(directory, "state-v2.backend.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy State-v2 migration rejects an oversized newline-terminated semantic key record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-stream-key-limit-"));
  try {
    await writeFile(join(directory, "state-v2.nodes.ndjson"), "", { mode: 0o600 });
    await writeFile(join(directory, "state-v2.keys.ndjson"), `${"x".repeat(1_025)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => StateV2DiskStore.open(directory),
      /State v2 legacy semantic key line exceeds 1024 byte limit/
    );
    await assert.rejects(() => readFile(join(directory, "state-v2.keys.backend.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy State-v2 migration ignores only an unterminated oversized crash tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-stream-tail-"));
  try {
    const state = SparseMerkleState.empty().set("account:alice", { balanceAtoms: 9, nonce: 1 });
    const records = state.nodeRecords();
    await writeFile(
      join(directory, "state-v2.nodes.ndjson"),
      `${records.map(nodeLine).join("\n")}\n${"{".repeat((64 * 1024) + 20)}`,
      { mode: 0o600 }
    );
    await writeLegacyRoot(directory, state);
    await writeFile(join(directory, "state-v2.keys.ndjson"), `${keyLine("account:alice")}\n${"{".repeat(2_000)}`, { mode: 0o600 });

    const migrated = await StateV2DiskStore.open(directory);
    assert.equal(migrated.state().root(), state.root());
    assert.deepEqual(migrated.semanticKeyPreimages(), ["account:alice"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
