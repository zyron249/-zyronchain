import { readBoundedFileBuffer, type BoundedFileFaultHooks } from "./bounded-file.js";

export const CHAIN_CONTROL_FILE_MAX_BYTES = 4 * 1024;

/**
 * Read a local control file through the same descriptor-bound pathname
 * custody boundary used by other bounded local state files. This preserves
 * byte/non-empty/regular-file limits while also freezing the canonical path
 * before open and revalidating it after open/read on Windows.
 */
export async function readBoundedRegularControlFile(
  path: string,
  label: string,
  maxBytes = CHAIN_CONTROL_FILE_MAX_BYTES,
  faultHooks: BoundedFileFaultHooks = {}
): Promise<string> {
  const buffer = await readBoundedFileBuffer(path, maxBytes, label, faultHooks);
  if (buffer.length < 1) throw new Error(`${label} exceeds byte bounds or is not a regular file`);
  return buffer.toString("utf8");
}
