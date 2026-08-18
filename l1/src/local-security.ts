import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

export const MAX_PRIVATE_FILE_BYTES = 64 * 1024;

interface OpenedPrivateFile {
  handle: FileHandle;
  resolved: string;
  canonical: string;
}

export async function assertPrivateRegularFile(path: string, label: string): Promise<void> {
  const opened = await openValidatedPrivateFile(path, label);
  await opened.handle.close();
}

/**
 * Read a local secret only after validating the exact opened file descriptor.
 * The path itself must not be a symlink, POSIX group/other permission bits must
 * be clear, and on POSIX the descriptor inode/device must still match the path
 * after open so a path replacement between validation and read fails closed.
 * The canonical path is also re-resolved after open and after the bounded read;
 * this catches parent junction/reparse substitution on Windows before secret
 * bytes are returned to a parser or signer. POSIX opens additionally use
 * no-follow/non-blocking flags so symlink/FIFO substitution cannot redirect or
 * block secret loading. Reads are capped so oversized or concurrently growing
 * local secret files cannot trigger unbounded startup memory allocation.
 */
export async function readPrivateRegularFile(path: string, label: string): Promise<string> {
  const opened = await openValidatedPrivateFile(path, label);
  try {
    const metadata = await opened.handle.stat();
    if (metadata.size > MAX_PRIVATE_FILE_BYTES) {
      throw new Error(`${label} exceeds ${MAX_PRIVATE_FILE_BYTES} byte limit`);
    }
    const buffer = Buffer.allocUnsafe(MAX_PRIVATE_FILE_BYTES + 1);
    let total = 0;
    while (total <= MAX_PRIVATE_FILE_BYTES) {
      const { bytesRead } = await opened.handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_PRIVATE_FILE_BYTES) {
        throw new Error(`${label} exceeds ${MAX_PRIVATE_FILE_BYTES} byte limit`);
      }
    }
    await requireSamePrivateRegularFile(opened.resolved, label, opened.canonical, opened.handle, "during reading");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await opened.handle.close();
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
    await requireSamePrivateRegularFile(resolved, label, canonical, handle, "after opening");
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
  phase: string
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
    if ((descriptorMetadata.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be readable, writable, or executable by group/other users (0600 recommended)`);
    }
    if (descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino) {
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
