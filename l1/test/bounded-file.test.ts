import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

test("bounded UTF-8 reader rejects direct symbolic-link paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-bounded-file-link-"));
  const target = join(directory, "target.json");
  const link = join(directory, "state.json");
  try {
    await writeFile(target, "{}\n");
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (process.platform === "win32" && isLinkPrivilegeError(error)) {
        t.skip("Windows file symlink creation is not permitted on this runner");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => readBoundedUtf8File(link, 1024, "Test state"),
      /Test state must not be a symbolic link/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded UTF-8 reader rejects parent link or junction substitution during an opened read", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-bounded-file-parent-link-"));
  const firstRoot = join(directory, "first");
  const secondRoot = join(directory, "second");
  const linkedRoot = join(directory, "current");
  try {
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await writeFile(join(firstRoot, "state.json"), "first\n");
    await writeFile(join(secondRoot, "state.json"), "second\n");
    try {
      await symlink(firstRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && isLinkPrivilegeError(error)) {
        t.skip("Windows junction creation is not permitted on this runner");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => readBoundedUtf8File(join(linkedRoot, "state.json"), 1024, "Test state", {
        afterOpenValidated: async () => {
          await unlink(linkedRoot);
          await symlink(secondRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
        }
      }),
      /Test state changed during reading/
    );
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

function isLinkPrivilegeError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    ["EPERM", "EACCES", "UNKNOWN"].includes(String((error as { code?: string }).code)));
}
