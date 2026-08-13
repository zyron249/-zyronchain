import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRecoveryCheckpointUtf8 } from "../src/recovery-file.js";

test("recovery checkpoint reader rejects POSIX symlink substitution", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-recovery-file-symlink-"));
  try {
    const target = join(directory, "checkpoint-target.json");
    const path = join(directory, "recovery-checkpoint.json");
    await writeFile(target, '{"version":1}\n', { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(() => readRecoveryCheckpointUtf8(path), /ELOOP|too many symbolic links/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
