import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readStateV2MetadataFile } from "../src/state-v2-store.js";

test("State-v2 metadata reader accepts the exact byte boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-metadata-boundary-"));
  const path = join(directory, "metadata.json");
  try {
    const text = "a".repeat(64);
    await writeFile(path, text, "utf8");
    assert.equal(await readStateV2MetadataFile(path, 64), text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State-v2 metadata reader rejects an oversized file before unbounded allocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-metadata-oversized-"));
  const path = join(directory, "metadata.json");
  try {
    await writeFile(path, "a".repeat(65), "utf8");
    await assert.rejects(() => readStateV2MetadataFile(path, 64), /byte bounds/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State-v2 metadata reader rejects a symlink instead of following it", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-metadata-symlink-"));
  const target = join(directory, "target.json");
  const path = join(directory, "metadata.json");
  try {
    await writeFile(target, "canonical", "utf8");
    await symlink(target, path);
    await assert.rejects(
      () => readStateV2MetadataFile(path, 64),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ELOOP")
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
