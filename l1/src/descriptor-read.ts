import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/**
 * Read one local operator/recovery input through the same descriptor that was
 * authenticated as a regular file.
 *
 * On POSIX, O_NOFOLLOW rejects final-component symlink substitution and
 * O_NONBLOCK prevents a substituted FIFO/device from blocking open(). On
 * platforms where those flags are unavailable, an lstat precheck still rejects
 * an already-present symbolic link and the descriptor fstat below rejects
 * non-regular files. Callers must continue to validate the file contents after
 * this local filesystem boundary.
 */
export async function readRegularFileDescriptorBound(path: string): Promise<Buffer> {
  if (path.length < 1) throw new Error("File path is required");

  if (process.platform === "win32") {
    const before = await lstat(path);
    if (before.isSymbolicLink()) throw new Error("Refusing symbolic-link input");
  }

  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const nonBlock = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Refusing non-regular file input");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readRegularUtf8FileDescriptorBound(path: string): Promise<string> {
  return (await readRegularFileDescriptorBound(path)).toString("utf8");
}
