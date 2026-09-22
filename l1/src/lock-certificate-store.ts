import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type { PrepareVote } from "./types.js";

const encoder = new TextEncoder();

/**
 * Durable copy of the prepare quorum that justified a commit.
 * The file is fsynced before the commit signature is released. Losing the
 * journal commit and keeping this file does not create a lock. Losing this
 * file while keeping the commit refuses a nil view-change until the same
 * quorum is supplied again and rewritten.
 */
export function lockCertificatePath(directory: string, height: number, round: number): string {
  if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(round) || round < 0) {
    throw new Error("Invalid lock certificate slot");
  }
  return join(directory, `${height}-${round}.json`);
}

export async function writeLockCertificate(
  directory: string,
  height: number,
  round: number,
  prepares: readonly PrepareVote[]
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = lockCertificatePath(directory, height, round);
  const temporary = `${path}.${process.pid}.tmp`;
  const payload = encoder.encode(JSON.stringify(prepares));
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.write(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export async function readLockCertificate(
  directory: string,
  height: number,
  round: number
): Promise<PrepareVote[] | undefined> {
  let text: string;
  try {
    text = await readFile(lockCertificatePath(directory, height, round), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error("Lock certificate store is unreadable", { cause: error });
  }
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Lock certificate store is corrupt");
  return parsed as PrepareVote[];
}

export async function removeLockCertificate(directory: string, height: number, round: number): Promise<void> {
  await rm(lockCertificatePath(directory, height, round), { force: true });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "ENOENT";
}
