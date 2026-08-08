import { mkdir, open, readFile, rename } from "node:fs/promises";
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
      metadata = parseRootMetadata(await readFile(metadataPath, "utf8"));
    } catch (error) {
      if (!isMissingFile(error)) { nodeObjects.close(); throw error; }
    }
    try {
      if (!(await loadBackendMarker(dataDir))) {
        const legacy = await loadLegacyNodeRecords(dataDir);
        if (metadata && metadata.root !== SparseMerkleState.empty().root()) {
          const legacyState = SparseMerkleState.fromNodeRecords(metadata.root, legacy.records.values());
          const reachable = legacyState.reachableNodeHashes();
          const records = [...legacy.records].filter(([hash]) => reachable.has(hash)).map(([, record]) => record);
          await nodeObjects.putMany(records);
          // Publish the backend marker only after the new database independently
          // resolves and authenticates the complete committed root.
          nodeObjects.validateReachable(SparseMerkleState.fromNodeResolver(metadata.root, nodeObjects.resolver()), false);
          if (legacy.unterminatedTail.length > 0 || legacy.completeLines !== records.length) {
            await compactNodeLog(dataDir, records);
          }
        }
        await writeBackendMarker(dataDir);
      }
      if (!(await loadSemanticBackendMarker(dataDir))) {
        const legacyKeys = await loadSemanticKeyPreimages(dataDir);
        await nodeObjects.putSemanticKeys(legacyKeys);
        for (const key of legacyKeys) {
          if (nodeObjects.semanticKey(stateV2KeyHash(key)) !== key) {
            throw new Error("State v2 semantic-key migration verification failed");
          }
        }
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

interface LegacyNodeLoad {
  records: Map<string, StateV2NodeRecord>;
  unterminatedTail: string;
  completeLines: number;
}

async function loadLegacyNodeRecords(dataDir: string): Promise<LegacyNodeLoad> {
  let text = "";
  try { text = await readFile(join(dataDir, "state-v2.nodes.ndjson"), "utf8"); }
  catch (error) {
    if (isMissingFile(error)) return { records: new Map(), unterminatedTail: "", completeLines: 0 };
    throw error;
  }
  const lines = text.split("\n");
  const unterminatedTail = lines.pop() ?? "";
  const records = new Map<string, StateV2NodeRecord>();
  let completeLines = 0;
  for (const line of lines) {
    if (!line) continue;
    completeLines += 1;
    const envelope = parseNodeEnvelope(line);
    const existing = records.get(envelope.record.hash);
    if (existing && canonicalJson(existing) !== canonicalJson(envelope.record)) {
      throw new Error("Conflicting duplicate persisted State v2 node");
    }
    records.set(envelope.record.hash, envelope.record);
  }
  return { records, unterminatedTail, completeLines };
}

async function loadBackendMarker(dataDir: string): Promise<BackendMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(join(dataDir, "state-v2.backend.json"), "utf8")) as Partial<BackendMarker>;
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

async function compactNodeLog(dataDir: string, records: Iterable<StateV2NodeRecord>): Promise<void> {
  const path = join(dataDir, "state-v2.nodes.ndjson");
  const temporary = `${path}.compact-${process.pid}-${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    for (const record of records) {
      const envelope: NodeEnvelope = { record, checksum: sha256Hex(canonicalJson(record)) };
      await handle.writeFile(`${canonicalJson(envelope)}\n`, "utf8");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dataDir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function loadSemanticKeyPreimages(dataDir: string): Promise<Set<string>> {
  const path = join(dataDir, "state-v2.keys.ndjson");
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return new Set();
  }
  const lines = text.split("\n");
  lines.pop(); // Ignore only an unterminated crash tail, as with node records.
  const keys = new Set<string>();
  for (const line of lines) {
    if (!line) continue;
    if (Buffer.byteLength(line, "utf8") > 1_024) throw new Error("Corrupt persisted State v2 semantic key");
    const value = JSON.parse(line) as Partial<KeyEnvelope>;
    if (typeof value.key !== "string" || value.key.length < 1 || value.key.length > 256 || typeof value.checksum !== "string") {
      throw new Error("Corrupt persisted State v2 semantic key");
    }
    const body: KeyEnvelopeBody = { key: value.key };
    if (sha256Hex(canonicalJson(body)) !== value.checksum) throw new Error("State v2 semantic key checksum mismatch");
    keys.add(value.key);
  }
  return keys;
}

async function loadSemanticBackendMarker(dataDir: string): Promise<SemanticBackendMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(join(dataDir, "state-v2.keys.backend.json"), "utf8")) as Partial<SemanticBackendMarker>;
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

function parseNodeEnvelope(line: string): NodeEnvelope {
  const value = JSON.parse(line) as Partial<NodeEnvelope>;
  if (!value || typeof value !== "object" || typeof value.checksum !== "string" || !value.record ||
      typeof value.record !== "object") throw new Error("Corrupt persisted State v2 node");
  if (sha256Hex(canonicalJson(value.record)) !== value.checksum) throw new Error("State v2 node checksum mismatch");
  if (typeof value.record.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.record.hash)) {
    throw new Error("Invalid persisted State v2 node hash");
  }
  return value as NodeEnvelope;
}

function parseRootMetadata(text: string): RootMetadata {
  const value = JSON.parse(text) as Partial<RootMetadata>;
  if (value.version !== 1 || typeof value.root !== "string" || !/^[0-9a-f]{64}$/.test(value.root) ||
      typeof value.checksum !== "string") throw new Error("Corrupt State v2 root metadata");
  const body: RootMetadataBody = { version: 1, root: value.root };
  if (sha256Hex(canonicalJson(body)) !== value.checksum) throw new Error("State v2 root checksum mismatch");
  return value as RootMetadata;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
