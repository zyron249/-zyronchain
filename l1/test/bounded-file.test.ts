import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBoundedUtf8File } from "../src/bounded-file.js";

test("bounded UTF-8 reader accepts the exact byte boundary and rejects one byte over", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-bounded-file-"));
  const path = join(directory, "state.json");
  try {
    await writeFile(path, Buffer.alloc(1024, 0x61));
    assert.equal((await readBoundedUtf8File(path, 1024, "Test state")).length, 1024);

    await writeFile(path, Buffer.alloc(1025, 0x61));
    await assert.rejects(
      () => readBoundedUtf8File(path, 1024, "Test state"),
      /Test state exceeds 1024 byte limit/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded UTF-8 reader rejects POSIX symlink paths", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-bounded-file-link-"));
  const target = join(directory, "target.json");
  const link = join(directory, "state.json");
  try {
    await writeFile(target, "{}\n");
    await symlink(target, link);
    await assert.rejects(() => readBoundedUtf8File(link, 1024, "Test state"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded UTF-8 reader rejects non-regular files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-bounded-file-type-"));
  try {
    await assert.rejects(
      () => readBoundedUtf8File(directory, 1024, "Test state"),
      /Test state must be a regular file/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
