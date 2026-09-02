import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("POSIX miner custody persists namespace entries before acknowledging success", async () => {
  const source = await readFile(join(process.cwd(), "native", "miner-custody-posix.c"), "utf8");

  assert.match(source, /static void sync_directory\(int fd, const char \*what\)/);
  assert.match(source, /mkdirat\(parent_fd, name, 0700\)[\s\S]*?sync_directory\(parent_fd, "fsync parent directory after reserve"\)/);
  assert.match(source, /fsync\(fd\)[\s\S]*?close\(fd\)[\s\S]*?sync_directory\(parent_fd, "fsync parent directory after write"\)/);
  assert.match(source, /fsync\(dest_fd\)[\s\S]*?close\(dest_fd\)[\s\S]*?close\(source_fd\)[\s\S]*?sync_directory\(parent_fd, "fsync parent directory after copy"\)/);

  assert.doesNotMatch(source, /EOPNOTSUPP|ENOTSUP/,
    "directory fsync failures must not be silently bypassed on unsupported filesystems");
});
