import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const CHAIN_CONTROL_FILE_MAX_BYTES = 4 * 1024;

export async function readBoundedRegularControlFile(
  path: string,
  label: string,
  maxBytes = CHAIN_CONTROL_FILE_MAX_BYTES
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid chain control-file byte limit");
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) {
      throw new Error(`${label} exceeds byte bounds or is not a regular file`);
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`${label} exceeds byte bounds`);
    }
    if (total < 1) throw new Error(`${label} exceeds byte bounds or is not a regular file`);
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}
