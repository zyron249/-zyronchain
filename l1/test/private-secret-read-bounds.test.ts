import assert from "node:assert/strict";
import { link, mkdtemp, open, rm, truncate, writeFile, type FileHandle } from "node:fs/promises";
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

test("private secret reads reject in-place content mutation during descriptor read", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-private-bound-mutate-"));
  const path = join(root, "secret.bin");
  await writeFile(path, Buffer.alloc(4_096, 0x63), { mode: 0o600 });

  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as { read: FileHandle["read"] };
  const originalRead = prototype.read;
  await probe.close();
  let mutated = false;

  const invokeOriginalRead = originalRead as unknown as (
    this: FileHandle,
    ...args: unknown[]
  ) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

  prototype.read = (async function (this: FileHandle, ...args: unknown[]) {
    const result = await invokeOriginalRead.apply(this, args);
    if (!mutated && result.bytesRead > 0) {
      mutated = true;
      await truncate(path, 2_048);
    }
    return result;
  }) as FileHandle["read"];

  try {
    await assert.rejects(
      () => readPrivateRegularFile(path, "Secret file"),
      /Secret file content changed during reading/
    );
    assert.equal(mutated, true);
  } finally {
    prototype.read = originalRead;
    await rm(root, { recursive: true, force: true });
  }
});

test("private secret reads tolerate metadata-only hard-link publication during descriptor read", { concurrency: false }, async (t) => {
  if (process.platform === "win32") {
    t.skip("hard-link metadata regression is POSIX-specific");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "zyron-private-bound-hardlink-"));
  const path = join(root, "secret.bin");
  const alias = join(root, "secret-published.bin");
  const expected = "stable-secret-content";
  await writeFile(path, expected, { mode: 0o600 });

  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as { read: FileHandle["read"] };
  const originalRead = prototype.read;
  await probe.close();
  let linked = false;

  const invokeOriginalRead = originalRead as unknown as (
    this: FileHandle,
    ...args: unknown[]
  ) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

  prototype.read = (async function (this: FileHandle, ...args: unknown[]) {
    const result = await invokeOriginalRead.apply(this, args);
    if (!linked && result.bytesRead > 0) {
      linked = true;
      await link(path, alias);
    }
    return result;
  }) as FileHandle["read"];

  try {
    assert.equal(await readPrivateRegularFile(path, "Secret file"), expected);
    assert.equal(linked, true);
  } finally {
    prototype.read = originalRead;
    await rm(root, { recursive: true, force: true });
  }
});
