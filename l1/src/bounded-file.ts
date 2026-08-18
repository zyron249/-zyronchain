import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

export interface BoundedFileFaultHooks {
  afterOpenValidated?: () => void | Promise<void>;
}

interface OpenedBoundedFile {
  handle: FileHandle;
  resolved: string;
  canonical: string;
}

/**
 * Read a local non-secret state file from one opened descriptor while keeping
 * memory bounded if the file is oversized initially or grows concurrently.
 * The path is frozen canonically before open and revalidated after open and
 * after the bounded read so parent symlink/junction/reparse substitution fails
 * closed before bytes reach a parser. POSIX additionally keeps no-follow,
 * non-blocking and descriptor/path device+inode checks.
 */
export async function readBoundedUtf8File(
  path: string,
  maxBytes: number,
  label: string,
  faultHooks: BoundedFileFaultHooks = {}
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid bounded file byte limit");
  const opened = await openValidatedBoundedFile(path, label);
  try {
    const metadata = await opened.handle.stat();
    if (metadata.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    await faultHooks.afterOpenValidated?.();

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await opened.handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    }
    await requireSameBoundedRegularFile(opened, label, "during reading");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await opened.handle.close();
  }
}

async function openValidatedBoundedFile(path: string, label: string): Promise<OpenedBoundedFile> {
  const resolved = resolve(path);
  const initialPathMetadata = await lstat(resolved);
  if (initialPathMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!initialPathMetadata.isFile()) throw new Error(`${label} must be a regular file`);
  const canonical = await realpath(resolved);
  const flags = process.platform === "win32"
    ? "r"
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(resolved, flags);
  const opened = { handle, resolved, canonical };
  try {
    await requireSameBoundedRegularFile(opened, label, "after opening");
    return opened;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function requireSameBoundedRegularFile(
  opened: OpenedBoundedFile,
  label: string,
  phase: string
): Promise<void> {
  const descriptorMetadata = await opened.handle.stat();
  const pathMetadata = await lstat(opened.resolved);
  if (pathMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!descriptorMetadata.isFile() || !pathMetadata.isFile()) throw new Error(`${label} must be a regular file`);
  const observedCanonical = await realpath(opened.resolved);
  if (observedCanonical !== opened.canonical) throw new Error(`${label} changed ${phase}`);
  if (process.platform !== "win32" &&
      (descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino)) {
    throw new Error(`${label} changed while being validated`);
  }
}
