import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import { canonicalJson, sha256Hex } from "./codec.js";
import {
  stateV2KeyHash,
  type SparseMerkleState,
  type StateV2NodeRecord,
  type StateV2NodeResolver
} from "./state-v2.js";

interface StoredNodeRow {
  record: string;
  checksum: string;
}

interface StoredSemanticKeyRow {
  key_hash: string;
  key: string;
  checksum: string;
}

interface CountRow { count: number }
interface TraversalCountRow { count: number; leaf_count: number }

export const DEFAULT_STATE_V2_NODE_CACHE = 4_096;

export class StateV2NodeObjectStore {
  private readonly cache = new Map<string, StateV2NodeRecord>();
  private readonly getStatement: Database.Statement<[string], StoredNodeRow>;
  private readonly insertStatement: Database.Statement<[string, string, string]>;
  private readonly getSemanticKeyStatement: Database.Statement<[string], StoredSemanticKeyRow>;
  private readonly insertSemanticKeyStatement: Database.Statement<[string, string, string]>;
  private readonly allSemanticKeysStatement: Database.Statement<[], StoredSemanticKeyRow>;
  private readonly nodeCountStatement: Database.Statement<[], CountRow>;
  private readonly semanticKeyCountStatement: Database.Statement<[], CountRow>;
  private readonly traversalDepthStatement: Database.Statement<[string], { depth: number }>;
  private readonly traversalRememberStatement: Database.Statement<[string, number]>;
  private readonly traversalLeafStatement: Database.Statement<[string, string]>;
  private readonly traversalClearStatement: Database.Statement<[]>;
  private readonly traversalCountStatement: Database.Statement<[], TraversalCountRow>;
  private readonly writeBatch: (records: readonly StateV2NodeRecord[]) => void;
  private readonly writeSemanticKeyBatch: (keys: readonly string[]) => void;

  private constructor(
    readonly path: string,
    private readonly database: Database.Database,
    private readonly cacheLimit: number
  ) {
    this.getStatement = database.prepare("SELECT record, checksum FROM nodes WHERE hash = ?");
    this.insertStatement = database.prepare("INSERT OR IGNORE INTO nodes(hash, record, checksum) VALUES (?, ?, ?)");
    this.getSemanticKeyStatement = database.prepare("SELECT key_hash, key, checksum FROM semantic_keys WHERE key_hash = ?");
    this.insertSemanticKeyStatement = database.prepare("INSERT OR IGNORE INTO semantic_keys(key_hash, key, checksum) VALUES (?, ?, ?)");
    this.allSemanticKeysStatement = database.prepare("SELECT key_hash, key, checksum FROM semantic_keys ORDER BY key_hash");
    this.nodeCountStatement = database.prepare("SELECT COUNT(*) AS count FROM nodes");
    this.semanticKeyCountStatement = database.prepare("SELECT COUNT(*) AS count FROM semantic_keys");
    this.traversalDepthStatement = database.prepare("SELECT depth FROM state_v2_traversal_seen WHERE hash = ?");
    this.traversalRememberStatement = database.prepare("INSERT INTO state_v2_traversal_seen(hash, depth) VALUES (?, ?)");
    this.traversalLeafStatement = database.prepare("UPDATE state_v2_traversal_seen SET key_hash = ? WHERE hash = ?");
    this.traversalClearStatement = database.prepare("DELETE FROM state_v2_traversal_seen");
    this.traversalCountStatement = database.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN key_hash IS NOT NULL THEN 1 ELSE 0 END), 0) AS leaf_count FROM state_v2_traversal_seen"
    );
    const transaction = database.transaction((records: readonly StateV2NodeRecord[]) => {
      for (const record of records) this.putOne(record);
    });
    this.writeBatch = (records) => transaction.immediate(records);
    const semanticTransaction = database.transaction((keys: readonly string[]) => {
      for (const key of keys) this.putSemanticKey(key);
    });
    this.writeSemanticKeyBatch = (keys) => semanticTransaction.immediate(keys);
  }

  static async open(dataDir: string, cacheLimit = DEFAULT_STATE_V2_NODE_CACHE): Promise<StateV2NodeObjectStore> {
    if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 0 || cacheLimit > 65_536) throw new Error("Invalid State v2 node cache limit");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "state-v2.nodes.sqlite");
    const database = new Database(path, { timeout: 5_000 });
    try {
      database.pragma("journal_mode = DELETE");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.pragma("trusted_schema = OFF");
      database.pragma("temp_store = FILE");
      if (database.pragma("temp_store", { simple: true }) !== 1) throw new Error("State v2 traversal requires file-backed SQLite temporary storage");
      database.exec(`
        CREATE TEMP TABLE state_v2_traversal_seen (
          hash TEXT PRIMARY KEY NOT NULL,
          depth INTEGER NOT NULL CHECK(depth >= 0 AND depth <= 256),
          key_hash TEXT CHECK(key_hash IS NULL OR length(key_hash) = 64)
        ) WITHOUT ROWID
      `);
      database.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash) = 64),
          record TEXT NOT NULL,
          checksum TEXT NOT NULL CHECK(length(checksum) = 64)
        ) WITHOUT ROWID
      `);
      database.exec(`
        CREATE TABLE IF NOT EXISTS semantic_keys (
          key_hash TEXT PRIMARY KEY NOT NULL CHECK(length(key_hash) = 64),
          key TEXT UNIQUE NOT NULL,
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

  resolver(): StateV2NodeResolver { return (hash) => this.get(hash); }

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

  cachedRecordCount(): number { return this.cache.size; }
  storedNodeCount(): number { return this.nodeCountStatement.get()?.count ?? 0; }
  storedSemanticKeyCount(): number { return this.semanticKeyCountStatement.get()?.count ?? 0; }

  semanticKey(keyHash: string): string | undefined {
    assertHash(keyHash);
    const row = this.getSemanticKeyStatement.get(keyHash);
    return row ? parseStoredSemanticKey(row, keyHash) : undefined;
  }

  async putSemanticKeys(keys: Iterable<string>): Promise<void> {
    const batch = [...new Set(keys)];
    for (const key of batch) assertSemanticKey(key);
    this.writeSemanticKeyBatch(batch);
  }

  allSemanticKeys(): string[] { return this.allSemanticKeysStatement.all().map((row) => parseStoredSemanticKey(row, row.key_hash)); }

  validateReachable(state: SparseMerkleState, requireSemanticKeys: boolean): void {
    this.traversalClearStatement.run();
    try { this.populateTraversal(state, requireSemanticKeys); }
    finally { this.traversalClearStatement.run(); }
  }

  reachableNodeCount(state: SparseMerkleState, requireSemanticKeys = false): number {
    return this.reachableCounts(state, requireSemanticKeys).nodes;
  }

  reachableCounts(state: SparseMerkleState, requireSemanticKeys = false): { nodes: number; leaves: number } {
    this.traversalClearStatement.run();
    try {
      this.populateTraversal(state, requireSemanticKeys);
      const row = this.traversalCountStatement.get();
      return { nodes: row?.count ?? 0, leaves: row?.leaf_count ?? 0 };
    } finally {
      this.traversalClearStatement.run();
    }
  }

  pruneUnreachable(state: SparseMerkleState): { removedNodes: number; removedSemanticKeys: number } {
    this.traversalClearStatement.run();
    try {
      this.populateTraversal(state, true);
      const transaction = this.database.transaction(() => {
        const removedNodes = this.database.prepare("DELETE FROM nodes WHERE hash NOT IN (SELECT hash FROM state_v2_traversal_seen)").run().changes;
        const removedSemanticKeys = this.database.prepare(
          "DELETE FROM semantic_keys WHERE key_hash NOT IN (SELECT key_hash FROM state_v2_traversal_seen WHERE key_hash IS NOT NULL)"
        ).run().changes;
        return { removedNodes, removedSemanticKeys };
      });
      const result = transaction.immediate();
      this.cache.clear();
      return result;
    } finally {
      this.traversalClearStatement.run();
    }
  }

  close(): void { this.cache.clear(); this.database.close(); }

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

  private putSemanticKey(key: string): void {
    const keyHash = stateV2KeyHash(key);
    const checksum = semanticKeyChecksum(keyHash, key);
    const result = this.insertSemanticKeyStatement.run(keyHash, key, checksum);
    if (result.changes === 1) return;
    const existing = this.getSemanticKeyStatement.get(keyHash);
    if (!existing) throw new Error("State v2 semantic-key insert conflict without existing record");
    const existingKey = parseStoredSemanticKey(existing, keyHash);
    if (existingKey !== key) throw new Error("Conflicting persisted State v2 semantic key");
  }

  private populateTraversal(state: SparseMerkleState, requireSemanticKeys: boolean): void {
    state.validateReachable({
      depth: (hash) => this.traversalDepthStatement.get(hash)?.depth,
      remember: (hash, depth) => { this.traversalRememberStatement.run(hash, depth); }
    }, (keyHash, nodeHash) => {
      const updated = this.traversalLeafStatement.run(keyHash, nodeHash);
      if (updated.changes !== 1) throw new Error("State v2 traversal lost a reachable leaf");
      if (requireSemanticKeys && this.semanticKey(keyHash) === undefined) throw new Error("Incomplete persisted State v2 semantic key index");
    });
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid persisted State v2 node object");
  const record = parsed as StateV2NodeRecord;
  if (record.hash !== expectedHash) throw new Error("State v2 node object key/hash mismatch");
  if (canonicalJson(record) !== row.record) throw new Error("Non-canonical persisted State v2 node object");
  return record;
}

function parseStoredSemanticKey(row: StoredSemanticKeyRow, expectedHash: string): string {
  if (row.key_hash !== expectedHash) throw new Error("State v2 semantic-key index/hash mismatch");
  assertSemanticKey(row.key);
  if (stateV2KeyHash(row.key) !== expectedHash) throw new Error("State v2 semantic-key preimage/hash mismatch");
  if (row.checksum !== semanticKeyChecksum(row.key_hash, row.key)) throw new Error("State v2 semantic key checksum mismatch");
  return row.key;
}

function semanticKeyChecksum(keyHash: string, key: string): string { return sha256Hex(canonicalJson({ keyHash, key })); }
function assertSemanticKey(key: string): void { if (typeof key !== "string" || key.length < 1 || key.length > 256) throw new Error("Invalid State v2 semantic key preimage"); }
function assertHash(hash: string): void { if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid State v2 node hash"); }
