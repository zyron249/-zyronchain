import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBoundedUtf8File } from "../src/bounded-file.js";

test("bounded file reader accepts a stable regular file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-bounded-file-stable-"));
  try {
    const target = join(dir, "checkpoint.json");
    await writeFile(target, "canonical", { mode: 0o600 });
    assert.equal(await readBoundedUtf8File(target, 1024, "checkpoint"), "canonical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded file reader rejects pathname replacement between initial validation and open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-bounded-file-replace-"));
  try {
    const target = join(dir, "checkpoint.json");
    const replacement = join(dir, "replacement.json");
    await writeFile(target, "trusted", { mode: 0o600 });
    await writeFile(replacement, "replacement", { mode: 0o600 });

    await assert.rejects(
      () => readBoundedUtf8File(target, 1024, "checkpoint", {
        afterInitialPathValidated: async () => {
          await rm(target);
          await rename(replacement, target);
        }
      }),
      /checkpoint changed before opening/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
