import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import { canonicalJson, sha256Hex } from "./codec.js";
import type { StateV2NodeRecord, StateV2NodeResolver } from "./state-v2.js";

interface StoredNodeRow {
  record: string;
  checksum: string;
}

export const DEFAULT_STATE_V2_NODE_CACHE = 4_096;

/**
 * Indexed durable storage for immutable content-addressed State-v2 nodes.
 *
 * SQLite provides the on-disk hash index, atomic transactions and crash-safe
 * durability. The synchronous API deliberately matches SparseMerkleState's
 * consensus resolver while a strict JS LRU bounds hydrated node records.
 */
export class StateV2NodeObjectStore {
  private readonly cache = new Map<string, StateV2NodeRecord>();
  private readonly getStatement: Database.Statement<[string], StoredNodeRow>;
  private readonly insertStatement: Database.Statement<[string, string, string]>;
  private readonly writeBatch: (records: readonly StateV2NodeRecord[]) => void;

  private constructor(
    readonly path: string,
    private readonly database: Database.Database,
    private readonly cacheLimit: number
  ) {
    this.getStatement = database.prepare("SELECT record, checksum FROM nodes WHERE hash = ?");
    this.insertStatement = database.prepare("INSERT OR IGNORE INTO nodes(hash, record, checksum) VALUES (?, ?, ?)");
    const transaction = database.transaction((records: readonly StateV2NodeRecord[]) => {
      for (const record of records) this.putOne(record);
    });
    this.writeBatch = (records) => transaction.immediate(records);
  }

  static async open(dataDir: string, cacheLimit = DEFAULT_STATE_V2_NODE_CACHE): Promise<StateV2NodeObjectStore> {
    if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 0 || cacheLimit > 65_536) {
      throw new Error("Invalid State v2 node cache limit");
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "state-v2.nodes.sqlite");
    const database = new Database(path, { timeout: 5_000 });
    try {
      database.pragma("journal_mode = DELETE");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.pragma("trusted_schema = OFF");
      database.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash) = 64),
          record TEXT NOT NULL,
          checksum TEXT NOT NULL CHECK(length(checksum) = 64)
        ) WITHOUT ROWID
      `);
      const integrity = database.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error("State v2 node database integrity check failed");
      return new StateV2NodeObjectStore(path, database, cacheLimit);
    } catch (error) {
      database.close();
      throw error;
    }
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
    const row = this.getStatement.get(hash);
    if (!row) return undefined;
    const record = parseStoredNode(row, hash);
    this.remember(record);
    return record;
  }

  async putMany(records: Iterable<StateV2NodeRecord>): Promise<void> {
    const batch = [...records];
    for (const record of batch) assertHash(record.hash);
    this.writeBatch(batch);
    for (const record of batch) this.remember(record);
  }

  cachedRecordCount(): number {
    return this.cache.size;
  }

  close(): void {
    this.cache.clear();
    this.database.close();
  }

  private putOne(record: StateV2NodeRecord): void {
    const recordJson = canonicalJson(record);
    const checksum = sha256Hex(recordJson);
    const result = this.insertStatement.run(record.hash, recordJson, checksum);
    if (result.changes === 1) return;
    const existing = this.getStatement.get(record.hash);
    if (!existing) throw new Error("State v2 node insert conflict without existing record");
    const parsed = parseStoredNode(existing, record.hash);
    if (canonicalJson(parsed) !== recordJson) throw new Error("Conflicting persisted State v2 node object");
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

function parseStoredNode(row: StoredNodeRow, expectedHash: string): StateV2NodeRecord {
  if (row.checksum !== sha256Hex(row.record)) throw new Error("State v2 node object checksum mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(row.record); } catch { throw new Error("Invalid persisted State v2 node object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid persisted State v2 node object");
  }
  const record = parsed as StateV2NodeRecord;
  if (record.hash !== expectedHash) throw new Error("State v2 node object key/hash mismatch");
  if (canonicalJson(record) !== row.record) throw new Error("Non-canonical persisted State v2 node object");
  return record;
}

function assertHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid State v2 node hash");
}

