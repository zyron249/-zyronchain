import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  CLI_GENESIS_MAX_BYTES,
  readCliCheckpointSnapshotUtf8,
  readCliGenesisUtf8
} from "../src/cli-recovery-file.js";

const execFileAsync = promisify(execFile);

test("CLI genesis reader accepts exact byte boundary and rejects oversized input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-genesis-bound-"));
  try {
    const exact = join(dir, "exact.json");
    const oversized = join(dir, "oversized.json");
    await writeFile(exact, "x".repeat(CLI_GENESIS_MAX_BYTES));
    await writeFile(oversized, "x".repeat(CLI_GENESIS_MAX_BYTES + 1));
    assert.equal((await readCliGenesisUtf8(exact)).length, CLI_GENESIS_MAX_BYTES);
    await assert.rejects(() => readCliGenesisUtf8(oversized), /exceeds byte bounds/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI checkpoint snapshot reader accepts a normal large regular file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-checkpoint-read-"));
  try {
    const path = join(dir, "snapshot.json");
    const text = "s".repeat(512 * 1024);
    await writeFile(path, text);
    assert.equal(await readCliCheckpointSnapshotUtf8(path), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI recovery readers reject directories as non-regular inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-recovery-directory-"));
  try {
    const nested = join(dir, "not-a-file");
    await mkdir(nested);
    await assert.rejects(() => readCliGenesisUtf8(nested));
    await assert.rejects(() => readCliCheckpointSnapshotUtf8(nested));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI recovery readers fail closed on POSIX symlink substitution", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-recovery-symlink-"));
  try {
    const target = join(dir, "target.json");
    const link = join(dir, "link.json");
    await writeFile(target, "{}\n");
    await symlink(target, link);
    await assert.rejects(() => readCliGenesisUtf8(link));
    await assert.rejects(() => readCliCheckpointSnapshotUtf8(link));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI recovery readers fail closed on POSIX FIFO substitution without blocking", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-recovery-fifo-"));
  try {
    const fifo = join(dir, "snapshot.pipe");
    await execFileAsync("mkfifo", [fifo]);
    await assert.rejects(() => readCliGenesisUtf8(fifo));
    await assert.rejects(() => readCliCheckpointSnapshotUtf8(fifo));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("published zyron-l1 bin routes through hardened entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { bin?: Record<string, string> };
  assert.equal(packageJson.bin?.["zyron-l1"], "dist/src/secure-cli.js");
});

test("hardened production entrypoint rejects a symlink genesis before node startup", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-entry-symlink-"));
  try {
    const target = join(dir, "genesis.json");
    const link = join(dir, "genesis-link.json");
    await writeFile(target, "{}\n");
    await symlink(target, link);
    const entry = fileURLToPath(new URL("../src/secure-cli.js", import.meta.url));
    await assert.rejects(
      () => execFileAsync(process.execPath, [entry, "node", "--genesis", link, "--data", join(dir, "data")], { timeout: 5_000 }),
      (error: unknown) => {
        const record = error as { stderr?: string; killed?: boolean };
        assert.equal(record.killed, false);
        assert.match(record.stderr ?? "", /Fatal:/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
