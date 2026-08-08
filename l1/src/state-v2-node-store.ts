import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson, sha256Hex } from "./codec.js";
import type { StateV2NodeRecord, StateV2NodeResolver } from "./state-v2.js";

interface NodeEnvelope {
  record: StateV2NodeRecord;
  checksum: string;
}

export const DEFAULT_STATE_V2_NODE_CACHE = 4_096;

/**
 * Immutable content-addressed State-v2 node objects.
 *
 * Hashes are sharded by their first byte, so lookup needs no RAM-resident hash
 * index. The synchronous resolver is intentional: SparseMerkleState's consensus
 * API is synchronous. A bounded LRU absorbs hot paths without changing that API.
 */
export class StateV2NodeObjectStore {
  private readonly cache = new Map<string, StateV2NodeRecord>();

  private constructor(readonly directory: string, private readonly cacheLimit: number) {}

  static async open(dataDir: string, cacheLimit = DEFAULT_STATE_V2_NODE_CACHE): Promise<StateV2NodeObjectStore> {
    if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 0 || cacheLimit > 65_536) {
      throw new Error("Invalid State v2 node cache limit");
    }
    const directory = join(dataDir, "state-v2.nodes");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new StateV2NodeObjectStore(directory, cacheLimit);
  }

  resolver(): StateV2NodeResolver {
    return (hash) => this.get(hash);
  }

  get(hash: string): StateV2NodeRecord | undefined {
    assertHash(hash);
    const cached = this.cache.get(hash);
    if (cached) {
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }
    let text: string;
    try {
      text = readFileSync(this.pathFor(hash), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    const record = parseEnvelope(text, hash);
    this.remember(record);
    return record;
  }

  async putMany(records: Iterable<StateV2NodeRecord>): Promise<void> {
    const syncedDirectories = new Set<string>();
    for (const record of records) {
      assertHash(record.hash);
      const path = this.pathFor(record.hash);
      const parent = dirname(path);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      try {
        const existing = parseEnvelope(await readFile(path, "utf8"), record.hash);
        if (canonicalJson(existing) !== canonicalJson(record)) {
          throw new Error("Conflicting persisted State v2 node object");
        }
        this.remember(existing);
        continue;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }

      const envelope: NodeEnvelope = { record, checksum: sha256Hex(canonicalJson(record)) };
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${canonicalJson(envelope)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      syncedDirectories.add(parent);
      this.remember(record);
    }
    for (const path of syncedDirectories) await syncDirectory(path);
  }

  cachedRecordCount(): number {
    return this.cache.size;
  }

  private pathFor(hash: string): string {
    return join(this.directory, hash.slice(0, 2), `${hash}.json`);
  }

  private remember(record: StateV2NodeRecord): void {
    if (this.cacheLimit === 0) return;
    this.cache.delete(record.hash);
    this.cache.set(record.hash, record);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function parseEnvelope(text: string, expectedHash: string): StateV2NodeRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Invalid persisted State v2 node object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid persisted State v2 node object");
  }
  const object = parsed as Partial<NodeEnvelope> & Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== "checksum,record" || typeof object.checksum !== "string" ||
      !object.record || typeof object.record !== "object" || Array.isArray(object.record)) {
    throw new Error("Invalid persisted State v2 node object");
  }
  const record = object.record as StateV2NodeRecord;
  if (record.hash !== expectedHash) throw new Error("State v2 node object path/hash mismatch");
  if (object.checksum !== sha256Hex(canonicalJson(record))) throw new Error("State v2 node object checksum mismatch");
  return record;
}

function assertHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid State v2 node hash");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
