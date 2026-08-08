import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "./codec.js";
import { SparseMerkleState, type StateV2NodeRecord } from "./state-v2.js";

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

/**
 * Crash-safe content-addressed persistence for State v2 nodes.
 *
 * New nodes are appended and fsynced before the root pointer is atomically
 * replaced. A crash before the root rename can leave harmless orphan nodes;
 * a committed root can therefore never intentionally point at unwritten data.
 */
export class StateV2DiskStore {
  private readonly knownRecords: Map<string, StateV2NodeRecord>;
  private currentState: SparseMerkleState;

  private constructor(
    readonly dataDir: string,
    state: SparseMerkleState,
    records: Map<string, StateV2NodeRecord>
  ) {
    this.currentState = state;
    this.knownRecords = records;
  }

  static async open(dataDir: string): Promise<StateV2DiskStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const nodesPath = join(dataDir, "state-v2.nodes.ndjson");
    const records = new Map<string, StateV2NodeRecord>();
    let text = "";
    try {
      text = await readFile(nodesPath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await writeFile(nodesPath, "", { flag: "wx", mode: 0o600 });
    }
    const lines = text.split("\n");
    const unterminatedTail = lines.pop() ?? "";
    // A crash during an append may leave bytes that were never made reachable by
    // the fsynced+renamed root. Ignore only an unterminated tail; complete corrupt
    // records fail closed.
    void unterminatedTail;
    for (const line of lines) {
      if (!line) continue;
      const envelope = parseNodeEnvelope(line);
      if (records.has(envelope.record.hash)) throw new Error("Duplicate persisted State v2 node");
      records.set(envelope.record.hash, envelope.record);
    }

    const metadataPath = join(dataDir, "state-v2.root.json");
    let state = SparseMerkleState.empty();
    try {
      const metadata = parseRootMetadata(await readFile(metadataPath, "utf8"));
      state = SparseMerkleState.fromNodeRecords(metadata.root, records.values());
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return new StateV2DiskStore(dataDir, state, records);
  }

  state(): SparseMerkleState {
    return this.currentState;
  }

  async commit(state: SparseMerkleState): Promise<void> {
    const nodesPath = join(this.dataDir, "state-v2.nodes.ndjson");
    // Existing pre-integration data directories can first reach this store with
    // a fully replayed state whose incremental delta has already been cleared.
    // Bootstrap the content-addressed store from the authenticated tree once;
    // subsequent commits retain the O(changed paths) pending-node fast path.
    const pending = state.pendingNodeRecords();
    const needsReplayCatchup = state.root() !== this.currentState.root() && pending.length === 0;
    const candidates = this.knownRecords.size === 0 || needsReplayCatchup ? state.nodeRecords() : pending;
    const fresh = candidates.filter((record) => !this.knownRecords.has(record.hash));
    if (fresh.length) {
      const handle = await open(nodesPath, "a", 0o600);
      try {
        for (const record of fresh) {
          const envelope: NodeEnvelope = { record, checksum: sha256Hex(canonicalJson(record)) };
          await handle.writeFile(`${canonicalJson(envelope)}\n`, "utf8");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (const record of fresh) this.knownRecords.set(record.hash, structuredClone(record));
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
    this.currentState = state.persistenceCheckpoint();
  }
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
