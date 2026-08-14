import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";

test("first node identity creation durably creates a nested data-directory chain", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-node-id-durable-"));
  const dataDir = join(root, "operator", "validator", "data");
  try {
    const first = await loadOrCreateNodeIdentity(dataDir);
    const second = await loadOrCreateNodeIdentity(dataDir);
    assert.deepEqual(second, first);

    for (const directory of [join(root, "operator"), join(root, "operator", "validator"), dataDir]) {
      const metadata = await stat(directory);
      assert.equal(metadata.isDirectory(), true);
      assert.equal(metadata.mode & 0o077, 0, `${directory} must not grant group/other permissions`);
    }
    assert.equal((await stat(join(dataDir, "node-identity.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node identity directory creation fails closed when an existing path component is not a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-node-id-component-"));
  const blocker = join(root, "not-a-directory");
  try {
    await writeFile(blocker, "blocked\n", "utf8");
    await assert.rejects(
      () => loadOrCreateNodeIdentity(join(blocker, "nested")),
      /not a directory|ENOTDIR/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
