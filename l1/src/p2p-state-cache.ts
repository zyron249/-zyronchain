import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const MAX_DURABLE_STATE_CACHE_BYTES = 512 * 1024 * 1024;

interface DurableCacheCandidate {
  path: string;
  mtimeMs: number;
  bytes: number;
}

interface StaleCacheEntry {
  path: string;
  bytes: number;
}

/**
 * Prunes the dedicated durable State-v2 serving cache under both an entry
 * count and aggregate byte ceiling. Canonical protected paths are immutable
 * for this operation. Non-canonical regular files/directories are treated as
 * stale cache material and removed only after the complete root is validated;
 * symlinks and other unsafe filesystem objects fail closed.
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
  const stale: StaleCacheEntry[] = [];
  let staleBytes = 0;
  for (const name of names) {
    const path = join(root, name);
    const info = await lstat(path);
    if (!/^[0-9a-f]{64}-[0-9a-f]{64}$/.test(name)) {
      if (info.isSymbolicLink()) throw new Error("Durable State-v2 cache contains a non-canonical symbolic link");
      let bytes: number;
      if (info.isDirectory()) bytes = await realDirectoryBytes(path);
      else if (info.isFile()) bytes = await stableRegularFileBytes(path, info);
      else throw new Error("Durable State-v2 cache contains a non-canonical non-regular entry");
      staleBytes = checkedAdd(staleBytes, bytes);
      stale.push({ path, bytes });
      continue;
    }
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

  // Stale entries are part of the cache-root resource boundary, but are never
  // preferred over canonical checkpoints. Remove them only after all root
  // entries and protected paths have been validated so malformed roots fail
  // closed without partial cleanup.
  if (staleBytes > 0 || stale.length > 0) {
    for (const entry of stale) await rm(entry.path, { recursive: true, force: true });
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

/**
 * Returns the descriptor-bound byte size of a regular cache file. The caller's
 * initial lstat snapshot is part of the identity contract so pathname
 * replacement or same-inode metadata mutation cannot silently change the byte
 * accounting source between discovery and measurement.
 */
export async function stableRegularFileBytes(path: string, initial: Stats): Promise<number> {
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new Error("Durable State-v2 cache file is not a real regular file");
  }
  const flags = process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    assertSameRegularFileSnapshot(initial, opened);
    const afterPath = await lstat(path);
    assertSameRegularFileSnapshot(opened, afterPath);
    const afterDescriptor = await handle.stat();
    assertSameRegularFileSnapshot(opened, afterDescriptor);
    return opened.size;
  } finally {
    await handle.close();
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
    total = checkedAdd(total, await stableRegularFileBytes(path, info));
  }

  const after = await lstat(directory);
  if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("Durable State-v2 cache directory changed during accounting");
  }
  return total;
}

function assertSameRegularFileSnapshot(expected: Stats, actual: Stats): void {
  if (actual.isSymbolicLink() || !actual.isFile() ||
      expected.dev !== actual.dev || expected.ino !== actual.ino ||
      expected.size !== actual.size || expected.mtimeMs !== actual.mtimeMs || expected.ctimeMs !== actual.ctimeMs) {
    throw new Error("Durable State-v2 cache file changed during accounting");
  }
}

function checkedAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Durable State-v2 cache byte accounting overflow");
  return total;
}
