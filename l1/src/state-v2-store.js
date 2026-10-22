import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { readBoundedUtf8File } from "./bounded-file.js";
import { canonicalJson, sha256Hex } from "./codec.js";
import { StateV2NodeObjectStore } from "./state-v2-node-store.js";
import { SparseMerkleState, stateV2KeyHash } from "./state-v2.js";
const LEGACY_NODE_LINE_MAX_BYTES = 64 * 1024;
const LEGACY_SEMANTIC_KEY_LINE_MAX_BYTES = 1_024;
const LEGACY_NODE_JSON_MAX_DEPTH = 64;
const LEGACY_NODE_JSON_MAX_STRUCTURAL_TOKENS = 16_384;
const LEGACY_SEMANTIC_KEY_JSON_MAX_DEPTH = 16;
const LEGACY_SEMANTIC_KEY_JSON_MAX_STRUCTURAL_TOKENS = 128;
const LEGACY_MIGRATION_BATCH_SIZE = 256;
const LEGACY_READ_CHUNK_BYTES = 16 * 1024;
export const STATE_V2_METADATA_MAX_BYTES = 4 * 1024;
/** Records per SQLite transaction when a whole state is written at once. */
export const STATE_V2_CATCHUP_BATCH_SIZE = 1_024;
/**
 * Semantic keys checked against the target root per catch-up step. Each check
 * resolves one key path (up to the tree depth), so this is smaller than the
 * record batch to keep every step comparably bounded.
 */
export const STATE_V2_CATCHUP_KEY_CHECK_BATCH_SIZE = 128;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
function assertCommittedSemanticKey(state, key) {
    if (typeof key !== "string" || key.length < 1 || key.length > 256)
        throw new Error("Invalid State v2 semantic key preimage");
    if (state.get(key) === undefined)
        throw new Error("State v2 semantic key is not committed by target root");
}
/**
 * Crash-safe content-addressed persistence for State v2 nodes.
 *
 * New nodes are appended and fsynced before the root pointer is atomically
 * replaced. A crash before the root rename can leave harmless orphan nodes;
 * a committed root can therefore never intentionally point at unwritten data.
 */
export class StateV2DiskStore {
    dataDir;
    nodeObjects;
    currentState;
    constructor(dataDir, state, nodeObjects) {
        this.dataDir = dataDir;
        this.nodeObjects = nodeObjects;
        this.currentState = state;
    }
    static async open(dataDir) {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const nodeObjects = await StateV2NodeObjectStore.open(dataDir);
        const metadataPath = join(dataDir, "state-v2.root.json");
        let metadata;
        try {
            metadata = parseRootMetadata(await readStateV2MetadataFile(metadataPath));
        }
        catch (error) {
            if (!isMissingFile(error)) {
                nodeObjects.close();
                throw error;
            }
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
        }
        catch (error) {
            nodeObjects.close();
            throw error;
        }
        try {
            const state = metadata ? SparseMerkleState.fromNodeResolver(metadata.root, nodeObjects.resolver()) : SparseMerkleState.empty();
            // Authenticate every root-reachable node and semantic-key binding. The
            // visit index lives in SQLite TEMP storage, not an O(n) JavaScript Set.
            nodeObjects.validateReachable(state, true);
            return new StateV2DiskStore(dataDir, state, nodeObjects);
        }
        catch (error) {
            nodeObjects.close();
            throw error;
        }
    }
    state() {
        return this.currentState;
    }
    residentNodeRecordCount() {
        return this.nodeObjects.cachedRecordCount();
    }
    /** Physically compact State-v2 objects after an explicit durable history prune. */
    pruneHistoricalObjects() {
        return this.nodeObjects.pruneUnreachable(this.currentState);
    }
    semanticKeyPreimages(state = this.currentState) {
        const leafHashes = state.leafKeyHashes();
        const keys = this.nodeObjects.allSemanticKeys().filter((key) => leafHashes.has(stateV2KeyHash(key))).sort();
        if (new Set(keys.map(stateV2KeyHash)).size !== leafHashes.size)
            throw new Error("Incomplete persisted State v2 semantic key index");
        return keys;
    }
    semanticIndexWouldBeComplete(state, proposed) {
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
        if (state.root() === this.currentState.root())
            return true;
        for (const hash of state.leafKeyHashes()) {
            if (!available.has(hash) && this.nodeObjects.semanticKey(hash) === undefined)
                return false;
        }
        return true;
    }
    async commit(state, keyPreimages = [], faultHooks = {}) {
        const pending = state.pendingNodeRecords();
        const needsReplayCatchup = state.root() !== this.currentState.root() && pending.length === 0;
        if (needsReplayCatchup) {
            await this.writeCatchup(state, keyPreimages, faultHooks);
        }
        else {
            await this.nodeObjects.putMany(pending);
            for (const key of keyPreimages)
                assertCommittedSemanticKey(state, key);
            await this.nodeObjects.putSemanticKeys(keyPreimages);
            await faultHooks.afterSemanticKeysSync?.();
            if (!this.semanticIndexWouldBeComplete(state, [])) {
                throw new Error("Refusing State v2 root commit without complete semantic key index");
            }
        }
        const body = { version: 1, root: state.root() };
        const metadata = { ...body, checksum: sha256Hex(canonicalJson(body)) };
        const metadataPath = join(this.dataDir, "state-v2.root.json");
        const temporary = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
        const metadataHandle = await open(temporary, "wx", 0o600);
        try {
            await metadataHandle.writeFile(`${canonicalJson(metadata)}\n`, "utf8");
            await metadataHandle.sync();
        }
        finally {
            await metadataHandle.close();
        }
        await rename(temporary, metadataPath);
        const directoryHandle = await open(this.dataDir, "r");
        try {
            await directoryHandle.sync();
        }
        finally {
            await directoryHandle.close();
        }
        this.currentState = SparseMerkleState.fromNodeResolver(state.root(), this.nodeObjects.resolver());
    }
    /**
     * Full catch-up (for example a store rebuilt from the finalized log): every
     * node record of the target state and its semantic keys. A large state is
     * handled in bounded steps with a progress callback and an event-loop yield
     * after each one, so the process stays responsive (Codex P2 on #1060):
     * - the records are collected lazily, batch by batch, while they are written
     *   (no whole-tree list is built first), and the leaf key hashes are noted;
     * - each semantic key is checked against the target root in small batches;
     * - the keys are written in batches;
     * - index completeness (every leaf of the target has its key) is checked in
     *   batches against the noted leaf key hashes, the same set leafKeyHashes()
     *   returns, instead of one more whole-tree traversal.
     * Node records are content-addressed and the root pointer is written only by
     * the caller after all of this succeeds, so an interruption at any step
     * leaves the previous root in place.
     */
    async writeCatchup(state, keyPreimages, faultHooks) {
        const step = async () => {
            faultHooks.onCatchupBatch?.();
            await yieldToEventLoop();
        };
        const leafKeyHashes = new Set();
        for (const records of state.nodeRecordBatches(STATE_V2_CATCHUP_BATCH_SIZE)) {
            for (const record of records)
                if (record.kind === "leaf")
                    leafKeyHashes.add(record.keyHash);
            await this.nodeObjects.putMany(records);
            await step();
        }
        for (let offset = 0; offset < keyPreimages.length; offset += STATE_V2_CATCHUP_KEY_CHECK_BATCH_SIZE) {
            for (const key of keyPreimages.slice(offset, offset + STATE_V2_CATCHUP_KEY_CHECK_BATCH_SIZE))
                assertCommittedSemanticKey(state, key);
            await step();
        }
        for (let offset = 0; offset < keyPreimages.length; offset += STATE_V2_CATCHUP_BATCH_SIZE) {
            await this.nodeObjects.putSemanticKeys(keyPreimages.slice(offset, offset + STATE_V2_CATCHUP_BATCH_SIZE));
            await step();
        }
        await faultHooks.afterSemanticKeysSync?.();
        let checked = 0;
        for (const keyHash of leafKeyHashes) {
            if (this.nodeObjects.semanticKey(keyHash) === undefined) {
                throw new Error("Refusing State v2 root commit without complete semantic key index");
            }
            checked += 1;
            if (checked % STATE_V2_CATCHUP_BATCH_SIZE === 0)
                await step();
        }
    }
}
async function migrateLegacyNodeRecords(dataDir, nodeObjects) {
    const batch = [];
    const flush = async () => {
        if (batch.length === 0)
            return;
        await nodeObjects.putMany(batch);
        batch.length = 0;
    };
    await forEachCompleteLegacyLine(join(dataDir, "state-v2.nodes.ndjson"), LEGACY_NODE_LINE_MAX_BYTES, "State v2 legacy node", LEGACY_NODE_JSON_MAX_DEPTH, LEGACY_NODE_JSON_MAX_STRUCTURAL_TOKENS, async (line) => {
        const envelope = parseNodeEnvelope(line);
        batch.push(envelope.record);
        if (batch.length >= LEGACY_MIGRATION_BATCH_SIZE)
            await flush();
    });
    await flush();
}
async function loadBackendMarker(dataDir) {
    try {
        const value = JSON.parse(await readStateV2MetadataFile(join(dataDir, "state-v2.backend.json")));
        if (value.version !== 1 || value.backend !== "sqlite-v1" || typeof value.checksum !== "string") {
            throw new Error("Corrupt State v2 backend marker");
        }
        const body = { version: 1, backend: "sqlite-v1" };
        if (value.checksum !== sha256Hex(canonicalJson(body)))
            throw new Error("State v2 backend marker checksum mismatch");
        return value;
    }
    catch (error) {
        if (isMissingFile(error))
            return undefined;
        throw error;
    }
}
async function writeBackendMarker(dataDir) {
    const body = { version: 1, backend: "sqlite-v1" };
    const marker = { ...body, checksum: sha256Hex(canonicalJson(body)) };
    const path = join(dataDir, "state-v2.backend.json");
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(`${canonicalJson(marker)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dataDir, "r");
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
async function migrateSemanticKeyPreimages(dataDir, nodeObjects) {
    const batch = [];
    const flush = async () => {
        if (batch.length === 0)
            return;
        await nodeObjects.putSemanticKeys(batch);
        for (const key of batch) {
            if (nodeObjects.semanticKey(stateV2KeyHash(key)) !== key) {
                throw new Error("State v2 semantic-key migration verification failed");
            }
        }
        batch.length = 0;
    };
    await forEachCompleteLegacyLine(join(dataDir, "state-v2.keys.ndjson"), LEGACY_SEMANTIC_KEY_LINE_MAX_BYTES, "State v2 legacy semantic key", LEGACY_SEMANTIC_KEY_JSON_MAX_DEPTH, LEGACY_SEMANTIC_KEY_JSON_MAX_STRUCTURAL_TOKENS, async (line) => {
        const key = parseSemanticKeyEnvelope(line);
        batch.push(key);
        if (batch.length >= LEGACY_MIGRATION_BATCH_SIZE)
            await flush();
    });
    await flush();
}
async function loadSemanticBackendMarker(dataDir) {
    try {
        const value = JSON.parse(await readStateV2MetadataFile(join(dataDir, "state-v2.keys.backend.json")));
        if (value.version !== 1 || value.backend !== "sqlite-semantic-v1" || typeof value.checksum !== "string") {
            throw new Error("Corrupt State v2 semantic backend marker");
        }
        const body = { version: 1, backend: "sqlite-semantic-v1" };
        if (value.checksum !== sha256Hex(canonicalJson(body)))
            throw new Error("State v2 semantic backend marker checksum mismatch");
        return value;
    }
    catch (error) {
        if (isMissingFile(error))
            return undefined;
        throw error;
    }
}
async function writeSemanticBackendMarker(dataDir) {
    const body = { version: 1, backend: "sqlite-semantic-v1" };
    const marker = { ...body, checksum: sha256Hex(canonicalJson(body)) };
    const path = join(dataDir, "state-v2.keys.backend.json");
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(`${canonicalJson(marker)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dataDir, "r");
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
export async function readStateV2MetadataFile(path, maxBytes = STATE_V2_METADATA_MAX_BYTES, faultHooks = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new Error("Invalid State v2 metadata byte limit");
    const text = await readBoundedUtf8File(path, maxBytes, "State v2 metadata", faultHooks);
    if (text.length < 1)
        throw new Error("State v2 metadata exceeds byte bounds or is not a regular file");
    return text;
}
async function forEachCompleteLegacyLine(path, maxLineBytes, label, maxJsonDepth, maxStructuralTokens, onLine) {
    let handle;
    try {
        handle = await open(path, "r");
    }
    catch (error) {
        if (isMissingFile(error))
            return;
        throw error;
    }
    const chunk = Buffer.allocUnsafe(LEGACY_READ_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let oversizedTail = false;
    try {
        while (true) {
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0)
                break;
            const view = chunk.subarray(0, bytesRead);
            let start = 0;
            for (let index = 0; index < view.length; index += 1) {
                if (view[index] !== 0x0a)
                    continue;
                const segment = view.subarray(start, index);
                if (oversizedTail || pending.length + segment.length > maxLineBytes) {
                    throw new Error(`${label} line exceeds ${maxLineBytes} byte limit`);
                }
                const lineBytes = pending.length === 0
                    ? Buffer.from(segment)
                    : Buffer.concat([pending, segment], pending.length + segment.length);
                pending = Buffer.alloc(0);
                if (lineBytes.length > 0) {
                    const line = lineBytes.toString("utf8");
                    assertLegacyJsonComplexity(line, label, maxJsonDepth, maxStructuralTokens);
                    await onLine(line);
                }
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
                }
                else if (remainder.length > 0) {
                    pending = pending.length === 0
                        ? Buffer.from(remainder)
                        : Buffer.concat([pending, remainder], pending.length + remainder.length);
                }
            }
        }
        // Intentionally ignore only the final unterminated record, including an
        // oversized one. Every newline-terminated record is byte-bounded and parsed.
    }
    finally {
        await handle.close();
    }
}
function assertLegacyJsonComplexity(line, label, maxDepth, maxStructuralTokens) {
    let depth = 0;
    let structuralTokens = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "{" || char === "[") {
            depth += 1;
            structuralTokens += 1;
            if (depth > maxDepth)
                throw new Error(`${label} JSON nesting exceeds ${maxDepth}`);
        }
        else if (char === "}" || char === "]") {
            depth = Math.max(0, depth - 1);
            structuralTokens += 1;
        }
        else if (char === "," || char === ":") {
            structuralTokens += 1;
        }
        if (structuralTokens > maxStructuralTokens) {
            throw new Error(`${label} JSON structure exceeds ${maxStructuralTokens} token limit`);
        }
    }
}
function parseNodeEnvelope(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        throw new Error("Corrupt persisted State v2 node");
    }
    const value = parsed;
    if (!value || typeof value !== "object" || typeof value.checksum !== "string" || !value.record ||
        typeof value.record !== "object")
        throw new Error("Corrupt persisted State v2 node");
    if (sha256Hex(canonicalJson(value.record)) !== value.checksum)
        throw new Error("State v2 node checksum mismatch");
    if (typeof value.record.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.record.hash)) {
        throw new Error("Invalid persisted State v2 node hash");
    }
    return value;
}
function parseSemanticKeyEnvelope(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        throw new Error("Corrupt persisted State v2 semantic key");
    }
    const value = parsed;
    if (typeof value.key !== "string" || value.key.length < 1 || value.key.length > 256 || typeof value.checksum !== "string") {
        throw new Error("Corrupt persisted State v2 semantic key");
    }
    const body = { key: value.key };
    if (sha256Hex(canonicalJson(body)) !== value.checksum)
        throw new Error("State v2 semantic key checksum mismatch");
    return value.key;
}
function parseRootMetadata(text) {
    const value = JSON.parse(text);
    if (value.version !== 1 || typeof value.root !== "string" || !/^[0-9a-f]{64}$/.test(value.root) ||
        typeof value.checksum !== "string")
        throw new Error("Corrupt State v2 root metadata");
    const body = { version: 1, root: value.root };
    if (value.checksum !== sha256Hex(canonicalJson(body)))
        throw new Error("State v2 root checksum mismatch");
    return value;
}
function isMissingFile(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
