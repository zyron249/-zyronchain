import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_MINER_GENESIS_JSON_NESTING_DEPTH,
  MAX_MINER_GENESIS_JSON_STRUCTURAL_TOKENS,
  MINER_GENESIS_MAX_BYTES,
  readMinerGenesis
} from "../src/miner-genesis.js";

function exactBoundaryJson(): string {
  const prefix = '{"chainId":"zyron-miner-boundary"}';
  return prefix + " ".repeat(MINER_GENESIS_MAX_BYTES - Buffer.byteLength(prefix, "utf8"));
}

test("miner genesis accepts valid JSON at the exact byte boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-miner-genesis-boundary-"));
  try {
    const path = join(directory, "genesis.json");
    const payload = exactBoundaryJson();
    assert.equal(Buffer.byteLength(payload, "utf8"), MINER_GENESIS_MAX_BYTES);
    await writeFile(path, payload, { mode: 0o600 });
    assert.deepEqual(await readMinerGenesis(path), { chainId: "zyron-miner-boundary" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("miner genesis rejects oversized input before JSON validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-miner-genesis-oversize-"));
  try {
    const path = join(directory, "genesis.json");
    await writeFile(path, " ".repeat(MINER_GENESIS_MAX_BYTES + 1), { mode: 0o600 });
    await assert.rejects(() => readMinerGenesis(path), /Miner genesis file exceeds byte bounds/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("miner genesis rejects excessive JSON nesting before parse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-miner-genesis-depth-"));
  try {
    const path = join(directory, "genesis.json");
    const depth = MAX_MINER_GENESIS_JSON_NESTING_DEPTH + 1;
    const payload = "[".repeat(depth) + "0" + "]".repeat(depth);
    assert.ok(Buffer.byteLength(payload, "utf8") < MINER_GENESIS_MAX_BYTES);
    await writeFile(path, payload, { mode: 0o600 });
    await assert.rejects(() => readMinerGenesis(path), /Miner genesis JSON complexity exceeded/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("miner genesis rejects excessive structural-token density before parse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-miner-genesis-tokens-"));
  try {
    const path = join(directory, "genesis.json");
    const commas = MAX_MINER_GENESIS_JSON_STRUCTURAL_TOKENS + 1;
    const payload = `[${"0,".repeat(commas)}0]`;
    assert.ok(Buffer.byteLength(payload, "utf8") < MINER_GENESIS_MAX_BYTES);
    await writeFile(path, payload, { mode: 0o600 });
    await assert.rejects(() => readMinerGenesis(path), /Miner genesis JSON complexity exceeded/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("miner genesis rejects POSIX symlink substitution", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-miner-genesis-symlink-"));
  try {
    const target = join(directory, "target.json");
    const path = join(directory, "genesis.json");
    await writeFile(target, '{"chainId":"zyron-target"}\n', { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(
      () => readMinerGenesis(path),
      /Miner genesis file must not be a symbolic link|ELOOP|too many symbolic links/i
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
