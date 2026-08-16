import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { readBoundedRegularControlFile } from "./control-file.js";

/** Keep operator-supplied genesis files bounded like the packaged miner. */
export const CLI_GENESIS_MAX_BYTES = 256 * 1024;

export async function readCliGenesisUtf8(path: string): Promise<string> {
  return readBoundedRegularControlFile(path, "CLI genesis file", CLI_GENESIS_MAX_BYTES);
}

/**
 * Trusted checkpoint snapshots can legitimately be large. Bind the read to one
 * regular-file descriptor and reject POSIX symlink/FIFO/device substitution,
 * but do not impose an arbitrary small byte cap that would reject valid state.
 */
export async function readCliCheckpointSnapshotUtf8(path: string): Promise<string> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1) throw new Error("CLI checkpoint snapshot is not a non-empty regular file");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}
