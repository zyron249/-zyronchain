import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRegularFileDescriptorBound, readRegularUtf8FileDescriptorBound } from "../src/descriptor-read.js";

test("descriptor-bound reader returns bytes from a regular file", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-descriptor-read-"));
  try {
    const path = join(root, "checkpoint.json");
    await writeFile(path, "{\"height\":7}\n", { mode: 0o600 });
    assert.equal(await readRegularUtf8FileDescriptorBound(path), "{\"height\":7}\n");
    assert.deepEqual(await readRegularFileDescriptorBound(path), Buffer.from("{\"height\":7}\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor-bound reader rejects non-regular inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-descriptor-read-"));
  try {
    const directory = join(root, "not-a-file");
    await mkdir(directory);
    await assert.rejects(readRegularFileDescriptorBound(directory), /non-regular file|EISDIR|illegal operation/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor-bound reader rejects symbolic-link substitution", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-descriptor-read-"));
  try {
    const target = join(root, "target.json");
    const link = join(root, "recovery-checkpoint.json");
    await writeFile(target, "secret", { mode: 0o600 });
    await symlink(target, link);
    await assert.rejects(readRegularFileDescriptorBound(link), /symbolic|ELOOP|too many levels/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
