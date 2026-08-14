import { SparseMerkleState } from "./state-v2.js";
import { StateV2NodeObjectStore } from "./state-v2-node-store.js";
import { parseStateV2PortableNodeRecord } from "./state-v2-portable.js";
import {
  DEFAULT_PORTABLE_RECORD_BATCH,
  streamPortableResumeRecords
} from "./state-v2-resume-stream.js";
import type { PortableStateResumeStore } from "./state-v2-resume.js";

export interface StagedPortableRecordState {
  state: SparseMerkleState;
  nodeObjects: StateV2NodeObjectStore;
  importedRecordCount: number;
}

/**
 * Import one completed resume store's node records without ever materializing
 * the full records[] bundle in JavaScript memory. The staging directory must be
 * dedicated to this import attempt.
 *
 * Every record retains the canonical portable-record parser. SQLite is then
 * used both as the content-addressed resolver and as file-backed traversal
 * bookkeeping so duplicate, unreachable and uncommitted records fail closed
 * without an O(n) JavaScript hash Set.
 */
export async function stagePortableResumeRecords(
  store: PortableStateResumeStore,
  stagingDir: string,
  batchSize = DEFAULT_PORTABLE_RECORD_BATCH
): Promise<StagedPortableRecordState> {
  if (stagingDir.length < 1) throw new Error("Portable state record staging directory is required");
  if (!store.complete()) throw new Error("Portable state resume is incomplete");
  if (!/^[0-9a-f]{64}$/.test(store.manifest.stateRoot)) throw new Error("Invalid portable state staging root");

  const nodeObjects = await StateV2NodeObjectStore.open(stagingDir);
  let importedRecordCount = 0;
  try {
    for await (const batch of streamPortableResumeRecords(store, batchSize)) {
      const parsed = batch.map(parseStateV2PortableNodeRecord);
      await nodeObjects.putMany(parsed);
      importedRecordCount += parsed.length;
      if (importedRecordCount > store.manifest.recordCount) {
        throw new Error("Portable state record staging exceeded manifest count");
      }
    }
    if (importedRecordCount !== store.manifest.recordCount) {
      throw new Error("Portable state record staging count mismatch");
    }

    // INSERT OR IGNORE is deliberately used by the immutable object store. A
    // smaller durable count therefore detects duplicate hashes without keeping
    // a second O(n) JavaScript Set during import.
    if (nodeObjects.storedNodeCount() !== importedRecordCount) {
      throw new Error("Portable state record staging contains duplicate node hashes");
    }

    const state = SparseMerkleState.fromNodeResolver(store.manifest.stateRoot, nodeObjects.resolver());
    const reachable = nodeObjects.reachableNodeCount(state, false);
    if (reachable !== importedRecordCount) {
      throw new Error("Portable state record staging contains unreachable or uncommitted nodes");
    }
    return { state, nodeObjects, importedRecordCount };
  } catch (error) {
    nodeObjects.close();
    throw error;
  }
}
