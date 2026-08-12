import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_PRIVATE_FILE_BYTES, readPrivateRegularFile } from "../src/local-security.js";

test("private secret reads accept the exact byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-private-bound-exact-"));
  const path = join(root, "secret.bin");
  try {
    await writeFile(path, Buffer.alloc(MAX_PRIVATE_FILE_BYTES, 0x61), { mode: 0o600 });
    const value = await readPrivateRegularFile(path, "Secret file");
    assert.equal(Buffer.byteLength(value, "utf8"), MAX_PRIVATE_FILE_BYTES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private secret reads fail closed above the shared byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-private-bound-large-"));
  const path = join(root, "secret.bin");
  try {
    await writeFile(path, Buffer.alloc(MAX_PRIVATE_FILE_BYTES + 1, 0x62), { mode: 0o600 });
    await assert.rejects(
      () => readPrivateRegularFile(path, "Secret file"),
      new RegExp(`Secret file exceeds ${MAX_PRIVATE_FILE_BYTES} byte limit`)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
