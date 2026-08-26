import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

export interface BoundedFileFaultHooks {
  afterInitialPathValidated?: () => void | Promise<void>;
  afterOpenValidated?: () => void | Promise<void>;
  beforeFinalValidation?: () => void | Promise<void>;
}

interface OpenedBoundedFile {
  handle: FileHandle;
  resolved: string;
  canonical: string;
}

interface BoundedFileSnapshot {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

const BYTE_REVALIDATION_CHUNK_BYTES = 64 * 1024;

/**
 * Read a local non-secret state file from one opened descriptor while keeping
 * memory bounded if the file is oversized initially or changes concurrently.
 * The initial pathname object identity is carried across descriptor open, and
 * the path is frozen canonically then revalidated after open and after the
 * bounded read so replacement, parent symlink/junction/reparse substitution,
 * same-inode content mutation, or later drift fails closed before bytes reach a
 * parser. POSIX additionally keeps no-follow and non-blocking open flags.
 */
export async function readBoundedFileBuffer(
  path: string,
  maxBytes: number,
  label: string,
  faultHooks: BoundedFileFaultHooks = {}
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid bounded file byte limit");
  const opened = await openValidatedBoundedFile(path, label, faultHooks);
  try {
    const metadata = await opened.handle.stat();
    if (metadata.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    const initialSnapshot: BoundedFileSnapshot = {
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs
    };
    await faultHooks.afterOpenValidated?.();

    // Allocate in proportion to the descriptor's validated size, not to the
    // configured ceiling. A separate one-byte sentinel read detects any growth
    // without forcing tiny files under a large ceiling to reserve the ceiling.
    const buffer = Buffer.allocUnsafe(initialSnapshot.size);
    let total = 0;
    while (total < initialSnapshot.size) {
      const { bytesRead } = await opened.handle.read(buffer, total, initialSnapshot.size - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total !== initialSnapshot.size) throw new Error(`${label} changed during reading`);

    const sentinel = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await opened.handle.read(sentinel, 0, 1, null);
    if (extraBytes !== 0) throw new Error(`${label} changed during reading`);

    await faultHooks.beforeFinalValidation?.();
    await requireSameBoundedRegularFile(opened, label, "during reading", initialSnapshot);
    await requireSameBoundedFileBytes(opened.handle, buffer, label);
    await requireSameBoundedRegularFile(opened, label, "during reading", initialSnapshot);
    return buffer;
  } finally {
    await opened.handle.close();
  }
}

export async function readBoundedUtf8File(
  path: string,
  maxBytes: number,
  label: string,
  faultHooks: BoundedFileFaultHooks = {}
): Promise<string> {
  return (await readBoundedFileBuffer(path, maxBytes, label, faultHooks)).toString("utf8");
}

async function openValidatedBoundedFile(
  path: string,
  label: string,
  faultHooks: BoundedFileFaultHooks
): Promise<OpenedBoundedFile> {
  const resolved = resolve(path);
  const initialPathMetadata = await lstat(resolved);
  if (initialPathMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!initialPathMetadata.isFile()) throw new Error(`${label} must be a regular file`);
  await faultHooks.afterInitialPathValidated?.();
  const canonical = await realpath(resolved);
  const flags = process.platform === "win32"
    ? "r"
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(resolved, flags);
  const opened = { handle, resolved, canonical };
  try {
    await requireSameBoundedRegularFile(
      opened,
      label,
      "after opening",
      undefined,
      initialPathMetadata
    );
    return opened;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function requireSameBoundedFileBytes(
  handle: FileHandle,
  expected: Buffer,
  label: string
): Promise<void> {
  const scratch = Buffer.allocUnsafe(Math.min(BYTE_REVALIDATION_CHUNK_BYTES, Math.max(1, expected.length)));
  let offset = 0;
  while (offset < expected.length) {
    const length = Math.min(scratch.length, expected.length - offset);
    const { bytesRead } = await handle.read(scratch, 0, length, offset);
    if (bytesRead !== length || !scratch.subarray(0, length).equals(expected.subarray(offset, offset + length))) {
      throw new Error(`${label} changed during reading`);
    }
    offset += length;
  }
  const sentinel = Buffer.allocUnsafe(1);
  const { bytesRead: extraBytes } = await handle.read(sentinel, 0, 1, expected.length);
  if (extraBytes !== 0) throw new Error(`${label} changed during reading`);
}

async function requireSameBoundedRegularFile(
  opened: OpenedBoundedFile,
  label: string,
  phase: string,
  expectedSnapshot?: BoundedFileSnapshot,
  initialPathMetadata?: { dev: number; ino: number }
): Promise<void> {
  const descriptorMetadata = await opened.handle.stat();
  const pathMetadata = await lstat(opened.resolved);
  if (pathMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!descriptorMetadata.isFile() || !pathMetadata.isFile()) throw new Error(`${label} must be a regular file`);
  if (initialPathMetadata &&
      (descriptorMetadata.dev !== initialPathMetadata.dev || descriptorMetadata.ino !== initialPathMetadata.ino)) {
    throw new Error(`${label} changed before opening`);
  }
  if (expectedSnapshot &&
      (descriptorMetadata.size !== expectedSnapshot.size ||
       descriptorMetadata.mtimeMs !== expectedSnapshot.mtimeMs ||
       descriptorMetadata.ctimeMs !== expectedSnapshot.ctimeMs)) {
    throw new Error(`${label} changed ${phase}`);
  }
  const observedCanonical = await realpath(opened.resolved);
  if (observedCanonical !== opened.canonical) throw new Error(`${label} changed ${phase}`);
  if (descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino) {
    throw new Error(`${label} changed while being validated`);
  }
}
