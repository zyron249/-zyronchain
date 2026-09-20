import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stableRegularFileBytes } from "../src/p2p-state-cache.js";

test("durable State-v2 cache rejects same-inode file mutation after discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-cache-file-identity-"));
  const path = join(root, "manifest.json");
  await writeFile(path, "before");
  const discovered = await lstat(path);
  // Size must change. Same-length writes can keep size+mtime+ctime identical on
  // coarse-timestamp filesystems, which would hide a same-inode mutation.
  await writeFile(path, "after-mutation");

  await assert.rejects(
    stableRegularFileBytes(path, discovered),
    /Durable State-v2 cache file changed during accounting/
  );
});

test("durable State-v2 cache rejects pathname replacement after discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-cache-file-identity-"));
  const path = join(root, "manifest.json");
  await writeFile(path, "first");
  const discovered = await lstat(path);
  await rm(path);
  await writeFile(path, "second");

  await assert.rejects(
    stableRegularFileBytes(path, discovered),
    /Durable State-v2 cache file changed during accounting/
  );
});
