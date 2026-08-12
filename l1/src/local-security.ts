import { lstat, open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

interface OpenedPrivateFile {
  handle: FileHandle;
  resolved: string;
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
 */
export async function readPrivateRegularFile(path: string, label: string): Promise<string> {
  const opened = await openValidatedPrivateFile(path, label);
  try {
    return await opened.handle.readFile({ encoding: "utf8" });
  } finally {
    await opened.handle.close();
  }
}

async function openValidatedPrivateFile(path: string, label: string): Promise<OpenedPrivateFile> {
  const resolved = resolve(path);
  const handle = await open(resolved, "r");
  try {
    const descriptorMetadata = await handle.stat();
    const pathMetadata = await lstat(resolved);
    if (pathMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    if (!descriptorMetadata.isFile() || !pathMetadata.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (process.platform !== "win32") {
      if ((descriptorMetadata.mode & 0o077) !== 0) {
        throw new Error(`${label} must not be readable, writable, or executable by group/other users (0600 recommended)`);
      }
      if (descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino) {
        throw new Error(`${label} changed while being validated`);
      }
    }
    return { handle, resolved };
  } catch (error) {
    await handle.close();
    throw error;
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
