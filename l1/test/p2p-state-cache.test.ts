import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pruneDurableStateCache } from "../src/p2p-state-cache.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

async function checkpoint(root: string, name: string, bytes: number): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, "records"), { recursive: true });
  await mkdir(join(path, "keys"), { recursive: true });
  await mkdir(join(path, ".tmp"), { recursive: true });
  await writeFile(join(path, "manifest.json"), "m".repeat(bytes));
  return path;
}

async function exists(path: string): Promise<boolean> {
  try { await readFile(join(path, "manifest.json")); return true; } catch { return false; }
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test("durable State-v2 cache prunes by aggregate bytes while preserving recency", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-cache-"));
  const first = await checkpoint(root, `${hashA}-${hashA}`, 40);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await checkpoint(root, `${hashB}-${hashB}`, 40);
  await pruneDurableStateCache(root, 2, new Set(), 60);
  assert.equal(await exists(first), false);
  assert.equal(await exists(second), true);
});

test("durable State-v2 cache never evicts protected material to satisfy byte quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-cache-"));
  const protectedPath = await checkpoint(root, `${hashA}-${hashB}`, 70);
  await assert.rejects(
    pruneDurableStateCache(root, 2, new Set([protectedPath]), 60),
    /Protected durable State-v2 cache exceeds configured resource ceiling/
  );
  assert.equal(await exists(protectedPath), true);
});

test("durable State-v2 cache removes non-canonical regular stale material", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-cache-"));
  const protectedPath = await checkpoint(root, `${hashA}-${hashB}`, 20);
  const staleFile = join(root, "stale.tmp");
  const staleDir = join(root, "partial-checkpoint");
  await writeFile(staleFile, "x".repeat(80));
  await mkdir(staleDir);
  await writeFile(join(staleDir, "chunk.tmp"), "y".repeat(80));

  await pruneDurableStateCache(root, 2, new Set([protectedPath]), 60);

  assert.equal(await exists(protectedPath), true);
  assert.equal(await pathExists(staleFile), false);
  assert.equal(await pathExists(staleDir), false);
});

test("durable State-v2 cache fails closed on non-canonical root symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-cache-"));
  const protectedPath = await checkpoint(root, `${hashA}-${hashC}`, 1);
  const outside = join(await mkdtemp(join(tmpdir(), "zyron-state-cache-outside-")), "outside.txt");
  await writeFile(outside, "outside");
  const link = join(root, "stale-link");
  await symlink(outside, link);

  await assert.rejects(
    pruneDurableStateCache(root, 2, new Set([protectedPath]), 60),
    /non-canonical symbolic link/
  );
  assert.equal(await exists(protectedPath), true);
  assert.equal(await pathExists(link), true);
});

test("durable State-v2 cache rejects malformed canonical checkpoint entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-cache-"));
  const target = await checkpoint(root, `${hashA}-${hashC}`, 1);
  const link = join(root, `${hashC}-${hashA}`);
  await symlink(target, link, "dir");
  await assert.rejects(
    pruneDurableStateCache(root, 2, new Set(), 60),
    /not a real directory/
  );
});

test("durable State-v2 cache rejects symlinks inside canonical checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-cache-"));
  const path = await checkpoint(root, `${hashB}-${hashC}`, 1);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "x");
  await symlink(outside, join(path, "records", "0.json"));
  await assert.rejects(
    pruneDurableStateCache(root, 2, new Set(), 60),
    /symbolic link/
  );
});
