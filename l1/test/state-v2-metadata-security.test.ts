import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
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
    await assert.rejects(() => readStateV2MetadataFile(path, 64), /byte limit|byte bounds/);
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
    await assert.rejects(() => readStateV2MetadataFile(path, 64), /symbolic link/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("State-v2 metadata reader rejects parent path substitution after open", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-metadata-substitution-"));
  const live = join(directory, "live");
  const moved = join(directory, "moved");
  const replacement = join(directory, "replacement");
  const path = join(live, "metadata.json");
  try {
    await mkdir(live);
    await mkdir(replacement);
    await writeFile(path, "canonical", "utf8");
    await writeFile(join(replacement, "metadata.json"), "substituted", "utf8");
    await assert.rejects(
      () => readStateV2MetadataFile(path, 64, {
        afterOpenValidated: async () => {
          await rename(live, moved);
          try {
            await symlink(replacement, live, process.platform === "win32" ? "junction" : "dir");
          } catch (error) {
            if (process.platform === "win32" && error && typeof error === "object" && "code" in error &&
                ["EPERM", "EACCES", "UNKNOWN"].includes(String((error).code))) {
              t.skip("Windows runner cannot create a junction for substitution regression");
              return;
            }
            throw error;
          }
        }
      }),
      /changed during reading|regular file|symbolic link/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
