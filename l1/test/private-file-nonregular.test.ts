import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPrivateRegularFile } from "../src/local-security.js";

test("private file reader rejects a directory path before reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-private-path-"));
  const directory = join(root, "not-a-file");
  try {
    await mkdir(directory, { mode: 0o700 });
    await assert.rejects(readPrivateRegularFile(directory, "Private file"), /must be a regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
