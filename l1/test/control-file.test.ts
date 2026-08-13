import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";

import { CHAIN_CONTROL_FILE_MAX_BYTES, readBoundedRegularControlFile } from "../src/control-file.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zyron-control-file-"));
}

test("chain control-file reader accepts exact byte boundary", async () => {
  const dir = await temporaryDirectory();
  const path = join(dir, "metadata.json");
  const content = "x".repeat(CHAIN_CONTROL_FILE_MAX_BYTES);
  await writeFile(path, content, { mode: 0o600 });
  assert.equal(await readBoundedRegularControlFile(path, "Chain metadata"), content);
});

test("chain control-file reader rejects initial oversize without materializing it", async () => {
  const dir = await temporaryDirectory();
  const path = join(dir, "metadata.json");
  await writeFile(path, "x".repeat(CHAIN_CONTROL_FILE_MAX_BYTES + 1), { mode: 0o600 });
  await assert.rejects(
    readBoundedRegularControlFile(path, "Chain metadata"),
    /Chain metadata exceeds byte bounds/
  );
});

test("chain control-file reader rejects empty regular files", async () => {
  const dir = await temporaryDirectory();
  const path = join(dir, "history-retention.json");
  await writeFile(path, "", { mode: 0o600 });
  await assert.rejects(
    readBoundedRegularControlFile(path, "History retention marker"),
    /History retention marker exceeds byte bounds or is not a regular file/
  );
});

test("chain control-file reader rejects POSIX symlink substitution", { skip: process.platform === "win32" }, async () => {
  const dir = await temporaryDirectory();
  const target = join(dir, "target.json");
  const link = join(dir, "metadata.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await symlink(target, link);
  await assert.rejects(readBoundedRegularControlFile(link, "Chain metadata"));
});
