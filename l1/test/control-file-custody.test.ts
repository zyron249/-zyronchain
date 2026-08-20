import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readBoundedRegularControlFile } from "../src/control-file.js";

test("control-file reader rejects parent path substitution after open", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-control-custody-"));
  const live = join(dir, "live");
  const moved = join(dir, "moved");
  const replacement = join(dir, "replacement");
  const path = join(live, "control.json");
  try {
    await mkdir(live);
    await mkdir(replacement);
    await writeFile(path, "canonical\n", "utf8");
    await writeFile(join(replacement, "control.json"), "substituted\n", "utf8");
    await assert.rejects(
      () => readBoundedRegularControlFile(path, "Chain control file", 1024, {
        afterOpenValidated: async () => {
          await rename(live, moved);
          await symlink(replacement, live, "dir");
        }
      }),
      /changed during reading|regular file|symbolic link/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("control-file reader remains bounded after canonical-reader migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-control-bound-"));
  try {
    const path = join(dir, "control.json");
    await writeFile(path, "x".repeat(65), "utf8");
    await assert.rejects(
      () => readBoundedRegularControlFile(path, "Chain control file", 64),
      /exceeds byte bounds/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
