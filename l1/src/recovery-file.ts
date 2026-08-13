import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Reads a potentially large recovery checkpoint through one already-opened
 * regular-file descriptor. Recovery checkpoints legitimately embed full chain
 * snapshots, so this helper deliberately does not impose an arbitrary small
 * byte cap; integrity is still established by the checkpoint's anchored digest
 * and normal replay validation.
 */
export async function readRecoveryCheckpointUtf8(path: string): Promise<string> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Recovery checkpoint is not a regular file");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}
