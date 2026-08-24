import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { readPrivateRegularFile } from "../src/local-security.js";

test("local-secret primary read buffer is zeroized after UTF-8 conversion", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX secret mode setup is authoritative for this allocation regression");
  const root = await mkdtemp(join(tmpdir(), "zyron-local-secret-zeroize-"));
  const path = join(root, "secret.txt");
  const secret = "0123456789abcdef0123456789abcdef";
  const originalAllocUnsafe = Buffer.allocUnsafe;
  const allocations: Buffer[] = [];
  try {
    await writeFile(path, secret, { mode: 0o600 });
    Buffer.allocUnsafe = ((size: number) => {
      const buffer = originalAllocUnsafe(size);
      allocations.push(buffer);
      return buffer;
    }) as typeof Buffer.allocUnsafe;

    assert.equal(await readPrivateRegularFile(path, "Test secret"), secret);
    const primary = allocations.find((buffer) => buffer.length === Buffer.byteLength(secret) + 1);
    assert.ok(primary, "expected the descriptor-sized primary secret buffer allocation");
    assert.equal(primary.every((byte) => byte === 0), true, "primary local-secret buffer must be zeroized");
  } finally {
    Buffer.allocUnsafe = originalAllocUnsafe;
    await rm(root, { recursive: true, force: true });
  }
});

test("hard-link secret reread buffer is zeroized in a finally path", async () => {
  const source = await readFile(resolve(process.cwd(), "src/local-security.ts"), "utf8");
  const helper = source.match(/async function revalidatePrivateFileBytesAfterHardlinkTransition[\s\S]*?\n}\n\nasync function openValidatedPrivateFile/);
  assert.ok(helper, "expected hard-link byte revalidation helper");
  assert.match(helper[0], /const reread = Buffer\.allocUnsafe\(expectedMetadata\.size\);[\s\S]*?try \{[\s\S]*?\} finally \{\s*reread\.fill\(0\);\s*\}/);
});
