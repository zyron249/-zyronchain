import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const MAX_DURABLE_STATE_CACHE_BYTES = 512 * 1024 * 1024;

interface DurableCacheCandidate {
  path: string;
  mtimeMs: number;
  bytes: number;
}

/**
 * Prunes canonical durable State-v2 serving checkpoints under both an entry
 * count and aggregate byte ceiling. Protected paths are immutable for this
 * operation: if they alone exceed either ceiling, fail closed rather than
 * deleting material that may be serving an active request.
 */
export async function pruneDurableStateCache(
  root: string,
  keep: number,
  protectedPaths: ReadonlySet<string> = new Set(),
  maxBytes = MAX_DURABLE_STATE_CACHE_BYTES
): Promise<void> {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error("Invalid durable State-v2 cache entry ceiling");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid durable State-v2 cache byte ceiling");

  const names = await readdir(root);
  const candidates: DurableCacheCandidate[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}-[0-9a-f]{64}$/.test(name)) continue;
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Durable State-v2 cache checkpoint is not a real directory");
    }
    candidates.push({ path, mtimeMs: info.mtimeMs, bytes: await realDirectoryBytes(path) });
  }

  const knownPaths = new Set(candidates.map((candidate) => candidate.path));
  for (const protectedPath of protectedPaths) {
    if (!knownPaths.has(protectedPath)) {
      throw new Error("Protected durable State-v2 cache path is missing or non-canonical");
    }
  }

  const protectedCandidates = candidates.filter((candidate) => protectedPaths.has(candidate.path));
  const protectedBytes = protectedCandidates.reduce((total, candidate) => checkedAdd(total, candidate.bytes), 0);
  if (protectedCandidates.length > keep || protectedBytes > maxBytes) {
    throw new Error("Protected durable State-v2 cache exceeds configured resource ceiling");
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  let retainedCount = protectedCandidates.length;
  let retainedBytes = protectedBytes;
  for (const candidate of candidates) {
    if (protectedPaths.has(candidate.path)) continue;
    const nextBytes = checkedAdd(retainedBytes, candidate.bytes);
    if (retainedCount < keep && nextBytes <= maxBytes) {
      retainedCount += 1;
      retainedBytes = nextBytes;
      continue;
    }
    await rm(candidate.path, { recursive: true, force: true });
  }
}

async function realDirectoryBytes(directory: string): Promise<number> {
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("Durable State-v2 cache contains a non-directory path");
  }

  let total = 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Durable State-v2 cache contains a symbolic link");
    if (info.isDirectory()) {
      total = checkedAdd(total, await realDirectoryBytes(path));
      continue;
    }
    if (!info.isFile()) throw new Error("Durable State-v2 cache contains a non-regular entry");
    total = checkedAdd(total, info.size);
  }

  const after = await lstat(directory);
  if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("Durable State-v2 cache directory changed during accounting");
  }
  return total;
}

function checkedAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Durable State-v2 cache byte accounting overflow");
  return total;
}
