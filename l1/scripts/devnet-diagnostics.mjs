import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

// Diagnostic-only, bounded projection. Never return raw records, hashes,
// arbitrary error messages, or any content from development keystores.
export async function readSigningChoices(dataDirectory) {
  let handle;
  try {
    const path = join(dataDirectory, 'signing-journal.ndjson');
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return { status: 'not-regular' };
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return { status: 'not-regular' };
    if (stat.size > 64 * 1024) return { status: 'oversized' };
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > 64 * 1024) return { status: 'oversized' };
    const choices = [];
    let rejectedRecords = 0;
    for (const line of buffer.subarray(0, size).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        if (line.length > 1024) throw new Error();
        const item = JSON.parse(line);
        if (!item || typeof item !== 'object' || Array.isArray(item) ||
            Object.keys(item).sort().join(',') !== 'height,kind,round,value' ||
            !Number.isSafeInteger(item.height) || item.height < 1 ||
            !Number.isSafeInteger(item.round) || item.round < 0 ||
            !['attest', 'skip'].includes(item.kind) ||
            typeof item.value !== 'string' || !/^[0-9a-f]{64}$/.test(item.value)) throw new Error();
        choices.push({ height: item.height, round: item.round, kind: item.kind });
      } catch { rejectedRecords += 1; }
    }
    return { status: 'read', choices: choices.slice(-12),
      omittedRecords: Math.max(0, choices.length - 12), rejectedRecords };
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'unavailable' };
  } finally {
    await handle?.close();
  }
}
