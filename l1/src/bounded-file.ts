import { open } from "node:fs/promises";

/**
 * Read a local non-secret state file from one opened descriptor while keeping
 * memory bounded if the file is oversized initially or grows concurrently.
 */
export async function readBoundedUtf8File(path: string, maxBytes: number, label: string): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid bounded file byte limit");
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
    if (metadata.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}
