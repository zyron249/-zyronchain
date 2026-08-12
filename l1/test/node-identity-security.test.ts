import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";

test("persisted node identity rejects symbolic-link custody", { skip: process.platform === "win32" }, async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "zyron-node-id-source-"));
  const linkedDir = await mkdtemp(join(tmpdir(), "zyron-node-id-link-"));
  try {
    await loadOrCreateNodeIdentity(sourceDir);
    await symlink(join(sourceDir, "node-identity.json"), join(linkedDir, "node-identity.json"));
    await assert.rejects(
      () => loadOrCreateNodeIdentity(linkedDir),
      /Node identity file must not be a symbolic link/
    );
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(linkedDir, { recursive: true, force: true });
  }
});

test("persisted node identity rejects POSIX group or other permissions", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-node-id-mode-"));
  try {
    await loadOrCreateNodeIdentity(directory);
    const path = join(directory, "node-identity.json");
    await chmod(path, 0o644);
    await assert.rejects(
      () => loadOrCreateNodeIdentity(directory),
      /Node identity file must not be readable, writable, or executable by group\/other users/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent node identity first-create still converges under private descriptor reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-node-id-private-race-"));
  try {
    const identities = await Promise.all(
      Array.from({ length: 12 }, () => loadOrCreateNodeIdentity(directory))
    );
    for (const identity of identities.slice(1)) assert.deepEqual(identity, identities[0]);
    assert.deepEqual(await loadOrCreateNodeIdentity(directory), identities[0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
