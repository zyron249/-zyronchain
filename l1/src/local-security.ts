import { constants } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

export const MAX_PRIVATE_FILE_BYTES = 64 * 1024;

type PrivateFileStat = Awaited<ReturnType<FileHandle["stat"]>>;
export type PrivateFileSnapshotDisposition = "exact" | "hardlink-metadata" | "changed";

interface OpenedPrivateFile {
  handle: FileHandle;
  resolved: string;
  canonical: string;
}

/** @internal Shared by production validation and deterministic regression tests. */
export function samePrivateFileIdentity(
  expectedDev: number,
  expectedIno: number,
  actualDev: number,
  actualIno: number
): boolean {
  return expectedDev === actualDev && expectedIno === actualIno;
}

/** @internal Classify post-read descriptor metadata without trusting hard-link metadata as byte evidence. */
export function classifyPrivateFileSnapshot(
  expected: Pick<PrivateFileStat, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "nlink">,
  actual: Pick<PrivateFileStat, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "nlink">
): PrivateFileSnapshotDisposition {
  if (expected.dev !== actual.dev
      || expected.ino !== actual.ino
      || expected.size !== actual.size
      || expected.mtimeMs !== actual.mtimeMs) {
    return "changed";
  }
  if (expected.ctimeMs === actual.ctimeMs) return "exact";
  return expected.nlink !== actual.nlink ? "hardlink-metadata" : "changed";
}

/** @internal Compare bounded secret bytes by SHA-256 without exposing either value. */
export function samePrivateFileBytes(expected: Uint8Array, actual: Uint8Array): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

export async function assertPrivateRegularFile(path: string, label: string): Promise<void> {
  const opened = await openValidatedPrivateFile(path, label);
  await opened.handle.close();
}

/**
 * Read a local secret only after validating the exact opened file descriptor.
 * The path itself must not be a symlink, POSIX group/other permission bits must
 * be clear, and on POSIX the descriptor inode/device must still match both the
 * initial pre-open path identity and the path after open so a path replacement
 * between validation and read fails closed. POSIX secret files must also be
 * owned by the node process's effective UID so a privileged process does not
 * silently expand custody to another local user. The canonical path is also
 * re-resolved after open and after the bounded read; this catches parent
 * junction/reparse substitution on Windows before secret bytes are returned to
 * a parser or signer. The descriptor content snapshot (identity, size, mtime
 * and ctime) must remain stable across the read so an in-place writer cannot
 * make callers consume bytes from a changed secret. A ctime/link-count-only
 * transition used by atomic hard-link publication is accepted only after a
 * second descriptor-bound bounded read has the same SHA-256 as the bytes about
 * to be returned and the descriptor remains metadata-stable across that
 * revalidation. POSIX opens additionally use no-follow/non-blocking flags so
 * symlink/FIFO substitution cannot redirect or block secret loading. Reads are
 * capped and allocate only the bound descriptor size plus one overflow byte,
 * so small secrets do not pay ceiling-sized transient allocations and
 * concurrent growth still fails closed before bytes are returned.
 */
export async function readPrivateRegularFile(path: string, label: string): Promise<string> {
  const opened = await openValidatedPrivateFile(path, label);
  try {
    const metadata = await opened.handle.stat();
    if (metadata.size > MAX_PRIVATE_FILE_BYTES) {
      throw new Error(`${label} exceeds ${MAX_PRIVATE_FILE_BYTES} byte limit`);
    }
    const buffer = Buffer.allocUnsafe(metadata.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_PRIVATE_FILE_BYTES) {
        throw new Error(`${label} exceeds ${MAX_PRIVATE_FILE_BYTES} byte limit`);
      }
      if (total > metadata.size) {
        throw new Error(`${label} content changed during reading`);
      }
    }
    if (total !== metadata.size) {
      throw new Error(`${label} content changed during reading`);
    }
    await requireSamePrivateRegularFile(opened.resolved, label, opened.canonical, opened.handle, "during reading");
    const completedMetadata = await opened.handle.stat();
    const disposition = classifyPrivateFileSnapshot(metadata, completedMetadata);
    if (disposition === "changed") {
      throw new Error(`${label} content changed during reading`);
    }
    const secretBytes = buffer.subarray(0, total);
    if (disposition === "hardlink-metadata") {
      await revalidatePrivateFileBytesAfterHardlinkTransition(
        opened.handle,
        secretBytes,
        completedMetadata,
        label
      );
    }
    return secretBytes.toString("utf8");
  } finally {
    await opened.handle.close();
  }
}

async function revalidatePrivateFileBytesAfterHardlinkTransition(
  handle: FileHandle,
  expectedBytes: Uint8Array,
  expectedMetadata: PrivateFileStat,
  label: string
): Promise<void> {
  if (expectedMetadata.size > MAX_PRIVATE_FILE_BYTES || expectedMetadata.size !== expectedBytes.byteLength) {
    throw new Error(`${label} content changed during reading`);
  }
  const reread = Buffer.allocUnsafe(expectedMetadata.size);
  let total = 0;
  while (total < reread.length) {
    const { bytesRead } = await handle.read(reread, total, reread.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total !== expectedMetadata.size) {
    throw new Error(`${label} content changed during reading`);
  }
  const afterRereadMetadata = await handle.stat();
  if (classifyPrivateFileSnapshot(expectedMetadata, afterRereadMetadata) !== "exact") {
    throw new Error(`${label} content changed during reading`);
  }
  if (!samePrivateFileBytes(expectedBytes, reread)) {
    throw new Error(`${label} content changed during reading`);
  }
}

async function openValidatedPrivateFile(path: string, label: string): Promise<OpenedPrivateFile> {
  const resolved = resolve(path);
  const initialPathMetadata = await lstat(resolved);
  if (initialPathMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!initialPathMetadata.isFile()) throw new Error(`${label} must be a regular file`);
  const canonical = await realpath(resolved);

  const flags = process.platform === "win32"
    ? "r"
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(resolved, flags);
  try {
    await requireSamePrivateRegularFile(
      resolved,
      label,
      canonical,
      handle,
      "after opening",
      initialPathMetadata
    );
    return { handle, resolved, canonical };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function requireSamePrivateRegularFile(
  resolved: string,
  label: string,
  expectedCanonical: string,
  handle: FileHandle,
  phase: string,
  initialPathMetadata?: { dev: number; ino: number }
): Promise<void> {
  const descriptorMetadata = await handle.stat();
  const pathMetadata = await lstat(resolved);
  if (pathMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!descriptorMetadata.isFile() || !pathMetadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  const observedCanonical = await realpath(resolved);
  if (observedCanonical !== expectedCanonical) {
    throw new Error(`${label} changed ${phase}`);
  }
  if (process.platform !== "win32") {
    if (initialPathMetadata
        && !samePrivateFileIdentity(
          initialPathMetadata.dev,
          initialPathMetadata.ino,
          descriptorMetadata.dev,
          descriptorMetadata.ino
        )) {
      throw new Error(`${label} changed before opening`);
    }
    const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : null;
    if (effectiveUid !== null && descriptorMetadata.uid !== effectiveUid) {
      throw new Error(`${label} must be owned by the effective user`);
    }
    if ((descriptorMetadata.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be readable, writable, or executable by group/other users (0600 recommended)`);
    }
    if (!samePrivateFileIdentity(
      descriptorMetadata.dev,
      descriptorMetadata.ino,
      pathMetadata.dev,
      pathMetadata.ino
    )) {
      throw new Error(`${label} changed while being validated`);
    }
  }
}

export function normalizeSecureRpcUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("RPC URL must use HTTP(S)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid RPC URL");
  if (url.protocol === "http:" && !isLoopbackRpcHost(url.hostname)) {
    throw new Error("Remote RPC URL must use HTTPS; plaintext HTTP is allowed only for loopback");
  }
  return url.toString().replace(/\/$/, "");
}

export function isLoopbackRpcHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
