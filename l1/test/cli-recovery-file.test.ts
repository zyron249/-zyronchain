import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLI_GENESIS_MAX_BYTES,
  readCliCheckpointSnapshotUtf8,
  readCliGenesisUtf8
} from "../src/cli-recovery-file.js";

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
