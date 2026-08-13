import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRecoveryCheckpointUtf8 } from "../src/recovery-file.js";

test("recovery checkpoint reader returns regular-file bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-recovery-file-"));
  try {
    const path = join(directory, "recovery-checkpoint.json");
    const payload = '{"version":1,"snapshot":{"height":0}}\n';
    await writeFile(path, payload, { mode: 0o600 });
    assert.equal(await readRecoveryCheckpointUtf8(path), payload);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery checkpoint reader rejects a non-regular path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-recovery-file-dir-"));
  try {
    const path = join(directory, "recovery-checkpoint.json");
    await mkdir(path);
    await assert.rejects(() => readRecoveryCheckpointUtf8(path), /not a regular file|EISDIR/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
