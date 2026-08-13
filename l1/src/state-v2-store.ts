import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "./codec.js";
import { StateV2NodeObjectStore } from "./state-v2-node-store.js";
import { SparseMerkleState, stateV2KeyHash, type StateV2NodeRecord } from "./state-v2.js";

interface NodeEnvelope {
  record: StateV2NodeRecord;
  checksum: string;
}

interface RootMetadataBody {
  version: 1;
  root: string;
}

interface RootMetadata extends RootMetadataBody {
  checksum: string;
}

interface KeyEnvelopeBody { key: string }
interface KeyEnvelope extends KeyEnvelopeBody { checksum: string }
interface BackendMarkerBody { version: 1; backend: "sqlite-v1" }
interface BackendMarker extends BackendMarkerBody { checksum: string }
interface SemanticBackendMarkerBody { version: 1; backend: "sqlite-semantic-v1" }
interface SemanticBackendMarker extends SemanticBackendMarkerBody { checksum: string }

const LEGACY_NODE_LINE_MAX_BYTES = 64 * 1024;
const LEGACY_SEMANTIC_KEY_LINE_MAX_BYTES = 1_024;
const LEGACY_MIGRATION_BATCH_SIZE = 256;
const LEGACY_READ_CHUNK_BYTES = 16 * 1024;
export const STATE_V2_METADATA_MAX_BYTES = 4 * 1024;

export interface StateV2CommitFaultHooks {
  afterSemanticKeysSync?: () => void | Promise<void>;
}

/**
 * Crash-safe content-addressed persistence for State v2 nodes.
 *
 * New nodes are appended and fsynced before the root pointer is atomically
 * replaced. A crash before the root rename can leave harmless orphan nodes;
 * a committed root can therefore never intentionally point at unwritten data.
 */
export class StateV2DiskStore {
  private currentState: SparseMerkleState;

  private constructor(
    readonly dataDir: string,
    state: SparseMerkleState,
    private readonly nodeObjects: StateV2NodeObjectStore
  ) {
    this.currentState = state;
  }

  static async open(dataDir: string): Promise<StateV2DiskStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const nodeObjects = await StateV2NodeObjectStore.open(dataDir);
    const metadataPath = join(dataDir, "state-v2.root.json");
    let metadata: RootMetadata | undefined;
    try {
      metadata = parseRootMetadata(await readStateV2MetadataFile(metadataPath));
    } catch (error) {
      if (!isMissingFile(error)) { nodeObjects.close(); throw error; }
    }
    try {
      if (!(await loadBackendMarker(dataDir))) {
        await migrateLegacyNodeRecords(dataDir, nodeObjects);
        if (metadata && metadata.root !== SparseMerkleState.empty().root()) {
          const migratedState = SparseMerkleState.fromNodeResolver(metadata.root, nodeObjects.resolver());
          // Publish the backend marker only after SQLite independently resolves
          // and authenticates the complete committed legacy root. Migration may
          // leave unreachable immutable rows, which are harmless and removable
          // by the explicit authenticated history-prune path.
          nodeObjects.validateReachable(migratedState, false);
        }
        await writeBackendMarker(dataDir);
      }
      if (!(await loadSemanticBackendMarker(dataDir))) {
        await migrateSemanticKeyPreimages(dataDir, nodeObjects);
        await writeSemanticBackendMarker(dataDir);
      }
    } catch (error) {
      nodeObjects.close();
      throw error;
    }
    try {
      const state = metadata ? SparseMerkleState.fromNodeResolver(metadata.root, nodeObjects.resolver()) : SparseMerkleState.empty();
      // Authenticate every root-reachable node and semantic-key binding. The
      // visit index lives in SQLite TEMP storage, not an O(n) JavaScript Set.
      nodeObjects.validateReachable(state, true);
      return new StateV2DiskStore(dataDir, state, nodeObjects);
    } catch (error) {
      nodeObjects.close();
      throw error;
    }
  }

  state(): SparseMerkleState {
    return this.currentState;
  }

  residentNodeRecordCount(): number {
    return this.nodeObjects.cachedRecordCount();
  }

  /** Physically compact State-v2 objects after an explicit durable history prune. */
  pruneHistoricalObjects(): { removedNodes: number; removedSemanticKeys: number } {
    return this.nodeObjects.pruneUnreachable(this.currentState);
  }

  semanticKeyPreimages(state: SparseMerkleState = this.currentState): string[] {
    const leafHashes = state.leafKeyHashes();
    const keys = this.nodeObjects.allSemanticKeys().filter((key) => leafHashes.has(stateV2KeyHash(key))).sort();
    if (new Set(keys.map(stateV2KeyHash)).size !== leafHashes.size) throw new Error("Incomplete persisted State v2 semantic key index");
    return keys;
  }

  semanticIndexWouldBeComplete(state: SparseMerkleState, proposed: readonly string[]): boolean {
    const available = new Set(proposed.map(stateV2KeyHash));
    const pending = state.pendingNodeRecords();
    if (pending.length > 0) {
      for (const record of pending) {
        if (record.kind === "leaf" && !available.has(record.keyHash) && this.nodeObjects.semanticKey(record.keyHash) === undefined) {
          return false;
        }
      }
      return true;
    }
    if (state.root() === this.currentState.root()) return true;
    for (const hash of state.leafKeyHashes()) {
      if (!available.has(hash) && this.nodeObjects.semanticKey(hash) === undefined) return false;
    }
    return true;
  }

  async commit(
    state: SparseMerkleState,
    keyPreimages: readonly string[] = [],
    faultHooks: StateV2CommitFaultHooks = {}
  ): Promise<void> {
    const pending = state.pendingNodeRecords();
    const needsReplayCatchup = state.root() !== this.currentState.root() && pending.length === 0;
    await this.nodeObjects.putMany(needsReplayCatchup ? state.nodeRecords() : pending);

    for (const key of keyPreimages) {
      if (typeof key !== "string" || key.length < 1 || key.length > 256) throw new Error("Invalid State v2 semantic key preimage");
      if (state.get(key) === undefined) throw new Error("State v2 semantic key is not committed by target root");
    }
    await this.nodeObjects.putSemanticKeys(keyPreimages);
    await faultHooks.afterSemanticKeysSync?.();
    if (!this.semanticIndexWouldBeComplete(state, [])) {
      throw new Error("Refusing State v2 root commit without complete semantic key index");
    }

    const body: RootMetadataBody = { version: 1, root: state.root() };
    const metadata: RootMetadata = { ...body, checksum: sha256Hex(canonicalJson(body)) };
    const metadataPath = join(this.dataDir, "state-v2.root.json");
    const temporary = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
    const metadataHandle = await open(temporary, "wx", 0o600);
    try {
      await metadataHandle.writeFile(`${canonicalJson(metadata)}\n`, "utf8");
      await metadataHandle.sync();
    } finally {
      await metadataHandle.close();
    }
    await rename(temporary, metadataPath);
    const directoryHandle = await open(this.dataDir, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    this.currentState = SparseMerkleState.fromNodeResolver(state.root(), this.nodeObjects.resolver());
  }
}

async function migrateLegacyNodeRecords(dataDir: string, nodeObjects: StateV2NodeObjectStore): Promise<void> {
  const batch: StateV2NodeRecord[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await nodeObjects.putMany(batch);
    batch.length = 0;
  };
  await forEachCompleteLegacyLine(
    join(dataDir, "state-v2.nodes.ndjson"),
    LEGACY_NODE_LINE_MAX_BYTES,
    "State v2 legacy node",
    async (line) => {
      const envelope = parseNodeEnvelope(line);
      batch.push(envelope.record);
      if (batch.length >= LEGACY_MIGRATION_BATCH_SIZE) await flush();
    }
  );
  await flush();
}

async function loadBackendMarker(dataDir: string): Promise<BackendMarker | undefined> {
  try {
    const value = JSON.parse(await readStateV2MetadataFile(join(dataDir, "state-v2.backend.json"))) as Partial<BackendMarker>;
    if (value.version !== 1 || value.backend !== "sqlite-v1" || typeof value.checksum !== "string") {
      throw new Error("Corrupt State v2 backend marker");
    }
    const body: BackendMarkerBody = { version: 1, backend: "sqlite-v1" };
    if (value.checksum !== sha256Hex(canonicalJson(body))) throw new Error("State v2 backend marker checksum mismatch");
    return value as BackendMarker;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeBackendMarker(dataDir: string): Promise<void> {
  const body: BackendMarkerBody = { version: 1, backend: "sqlite-v1" };
  const marker: BackendMarker = { ...body, checksum: sha256Hex(canonicalJson(body)) };
  const path = join(dataDir, "state-v2.backend.json");
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${canonicalJson(marker)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dataDir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function migrateSemanticKeyPreimages(dataDir: string, nodeObjects: StateV2NodeObjectStore): Promise<void> {
  const batch: string[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await nodeObjects.putSemanticKeys(batch);
    for (const key of batch) {
      if (nodeObjects.semanticKey(stateV2KeyHash(key)) !== key) {
        throw new Error("State v2 semantic-key migration verification failed");
      }
    }
    batch.length = 0;
  };
  await forEachCompleteLegacyLine(
    join(dataDir, "state-v2.keys.ndjson"),
    LEGACY_SEMANTIC_KEY_LINE_MAX_BYTES,
    "State v2 legacy semantic key",
    async (line) => {
      const key = parseSemanticKeyEnvelope(line);
      batch.push(key);
      if (batch.length >= LEGACY_MIGRATION_BATCH_SIZE) await flush();
    }
  );
  await flush();
}

async function loadSemanticBackendMarker(dataDir: string): Promise<SemanticBackendMarker | undefined> {
  try {
    const value = JSON.parse(await readStateV2MetadataFile(join(dataDir, "state-v2.keys.backend.json"))) as Partial<SemanticBackendMarker>;
    if (value.version !== 1 || value.backend !== "sqlite-semantic-v1" || typeof value.checksum !== "string") {
      throw new Error("Corrupt State v2 semantic backend marker");
    }
    const body: SemanticBackendMarkerBody = { version: 1, backend: "sqlite-semantic-v1" };
    if (value.checksum !== sha256Hex(canonicalJson(body))) throw new Error("State v2 semantic backend marker checksum mismatch");
    return value as SemanticBackendMarker;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeSemanticBackendMarker(dataDir: string): Promise<void> {
  const body: SemanticBackendMarkerBody = { version: 1, backend: "sqlite-semantic-v1" };
  const marker: SemanticBackendMarker = { ...body, checksum: sha256Hex(canonicalJson(body)) };
  const path = join(dataDir, "state-v2.keys.backend.json");
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${canonicalJson(marker)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dataDir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function readStateV2MetadataFile(
  path: string,
  maxBytes = STATE_V2_METADATA_MAX_BYTES
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid State v2 metadata byte limit");
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) {
      throw new Error("State v2 metadata exceeds byte bounds or is not a regular file");
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("State v2 metadata exceeds byte bounds");
    }
    if (total < 1) throw new Error("State v2 metadata exceeds byte bounds or is not a regular file");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function forEachCompleteLegacyLine(
  path: string,
  maxLineBytes: number,
  label: string,
  onLine: (line: string) => void | Promise<void>
): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const chunk = Buffer.allocUnsafe(LEGACY_READ_CHUNK_BYTES);
  let pending = Buffer.alloc(0);
  let oversizedTail = false;
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      let start = 0;
      for (let index = 0; index < view.length; index += 1) {
        if (view[index] !== 0x0a) continue;
        const segment = view.subarray(start, index);
        if (oversizedTail || pending.length + segment.length > maxLineBytes) {
          throw new Error(`${label} line exceeds ${maxLineBytes} byte limit`);
        }
        const lineBytes = pending.length === 0
          ? Buffer.from(segment)
          : Buffer.concat([pending, segment], pending.length + segment.length);
        pending = Buffer.alloc(0);
        if (lineBytes.length > 0) await onLine(lineBytes.toString("utf8"));
        start = index + 1;
      }
      const remainder = view.subarray(start);
      if (!oversizedTail) {
        if (pending.length + remainder.length > maxLineBytes) {
          // Do not retain an attacker-controlled oversized partial line. If a
          // newline later terminates it, fail closed; if EOF arrives first it is
          // the one crash-tail record legacy recovery is allowed to ignore.
          pending = Buffer.alloc(0);
          oversizedTail = true;
        } else if (remainder.length > 0) {
          pending = pending.length === 0
            ? Buffer.from(remainder)
            : Buffer.concat([pending, remainder], pending.length + remainder.length);
        }
      }
    }
    // Intentionally ignore only the final unterminated record, including an
    // oversized one. Every newline-terminated record is byte-bounded and parsed.
  } finally {
    await handle.close();
  }
}

function parseNodeEnvelope(line: string): NodeEnvelope {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error("Corrupt persisted State v2 node"); }
  const value = parsed as Partial<NodeEnvelope>;
  if (!value || typeof value !== "object" || typeof value.checksum !== "string" || !value.record ||
      typeof value.record !== "object") throw new Error("Corrupt persisted State v2 node");
  if (sha256Hex(canonicalJson(value.record)) !== value.checksum) throw new Error("State v2 node checksum mismatch");
  if (typeof value.record.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.record.hash)) {
    throw new Error("Invalid persisted State v2 node hash");
  }
  return value as NodeEnvelope;
}

function parseSemanticKeyEnvelope(line: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error("Corrupt persisted State v2 semantic key"); }
  const value = parsed as Partial<KeyEnvelope>;
  if (typeof value.key !== "string" || value.key.length < 1 || value.key.length > 256 || typeof value.checksum !== "string") {
    throw new Error("Corrupt persisted State v2 semantic key");
  }
  const body: KeyEnvelopeBody = { key: value.key };
  if (sha256Hex(canonicalJson(body)) !== value.checksum) throw new Error("State v2 semantic key checksum mismatch");
  return value.key;
}

function parseRootMetadata(text: string): RootMetadata {
  const value = JSON.parse(text) as Partial<RootMetadata>;
  if (value.version !== 1 || typeof value.root !== "string" || !/^[0-9a-f]{64}$/.test(value.root) ||
      typeof value.checksum !== "string") throw new Error("Corrupt State v2 root metadata");
  const body: RootMetadataBody = { version: 1, root: value.root };
  if (value.checksum !== sha256Hex(canonicalJson(body))) throw new Error("State v2 root checksum mismatch");
  return value as RootMetadata;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}