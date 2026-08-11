import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertPrivateRegularFile, normalizeSecureRpcUrl } from "../src/local-security.js";

test("remote RPC requires HTTPS while loopback HTTP remains available for local nodes", () => {
  assert.equal(normalizeSecureRpcUrl("http://127.0.0.1:9137/"), "http://127.0.0.1:9137");
  assert.equal(normalizeSecureRpcUrl("http://localhost:9137"), "http://localhost:9137");
  assert.equal(normalizeSecureRpcUrl("http://[::1]:9137"), "http://[::1]:9137");
  assert.equal(normalizeSecureRpcUrl("https://node.example:9137/"), "https://node.example:9137");
  assert.throws(() => normalizeSecureRpcUrl("http://node.example:9137"), /must use HTTPS/);
  assert.throws(() => normalizeSecureRpcUrl("ftp://node.example"), /HTTP\(S\)/);
  assert.throws(() => normalizeSecureRpcUrl("https://user:pass@node.example"), /Invalid RPC URL/);
});

test("private local files reject group/other access on POSIX", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode bits are not authoritative on Windows");
  const root = await mkdtemp(join(tmpdir(), "zyron-private-file-"));
  const path = join(root, "secret.txt");
  try {
    await writeFile(path, "secret\n", { mode: 0o600 });
    await assertPrivateRegularFile(path, "Secret file");
    await chmod(path, 0o644);
    await assert.rejects(assertPrivateRegularFile(path, "Secret file"), /group\/other users/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
