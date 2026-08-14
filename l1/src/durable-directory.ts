import { open, stat, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Ensure a directory exists and, on POSIX, make any newly-created directory
 * entries crash-durable before returning. Existing directories are left
 * untouched apart from validation that the nearest existing ancestor is a
 * directory.
 */
export async function ensureDurableDirectory(path: string, mode = 0o700): Promise<void> {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) throw new Error("Invalid directory mode");
  const resolved = resolve(path);
  const missing: string[] = [];
  let cursor = resolved;

  while (true) {
    try {
      const metadata = await stat(cursor);
      if (!metadata.isDirectory()) throw new Error(`Directory path component is not a directory: ${cursor}`);
      break;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`Unable to locate existing parent directory for ${resolved}`);
      cursor = parent;
    }
  }

  await mkdir(resolved, { recursive: true, mode });
  if (process.platform === "win32" || missing.length === 0) return;

  // `missing` is leaf-to-root. Durably publish each newly-created entry from
  // the nearest existing ancestor toward the requested leaf. Syncing the new
  // directory itself also persists its metadata before it is used as the
  // parent for the next component.
  for (const directory of missing.reverse()) {
    await syncDirectory(dirname(directory));
    await syncDirectory(directory);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error(`Durability path is not a directory: ${path}`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
