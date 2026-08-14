import { SparseMerkleState } from "./state-v2.js";
import { StateV2NodeObjectStore } from "./state-v2-node-store.js";
import {
  parseStateV2PortableKeyPreimage,
  parseStateV2PortableNodeRecord
} from "./state-v2-portable.js";
import {
  DEFAULT_PORTABLE_KEY_BATCH,
  DEFAULT_PORTABLE_RECORD_BATCH,
  streamPortableResumeKeys,
  streamPortableResumeRecords
} from "./state-v2-resume-stream.js";
import type { PortableStateResumeStore } from "./state-v2-resume.js";

export interface StagedPortableRecordState {
  state: SparseMerkleState;
  nodeObjects: StateV2NodeObjectStore;
  importedRecordCount: number;
}

export interface CompletedPortableStateStage extends StagedPortableRecordState {
  importedKeyCount: number;
}

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
      if (importedRecordCount > store.manifest.recordCount) throw new Error("Portable state record staging exceeded manifest count");
    }
    if (importedRecordCount !== store.manifest.recordCount) throw new Error("Portable state record staging count mismatch");
    if (nodeObjects.storedNodeCount() !== importedRecordCount) throw new Error("Portable state record staging contains duplicate node hashes");

    const state = SparseMerkleState.fromNodeResolver(store.manifest.stateRoot, nodeObjects.resolver());
    const reachable = nodeObjects.reachableNodeCount(state, false);
    if (reachable !== importedRecordCount) throw new Error("Portable state record staging contains unreachable or uncommitted nodes");
    return { state, nodeObjects, importedRecordCount };
  } catch (error) {
    nodeObjects.close();
    throw error;
  }
}

/**
 * Import semantic-key preimages in bounded batches and prove exact completeness
 * against the already-authenticated staged root. The SQLite object store enforces
 * key-hash uniqueness, while file-backed root traversal proves every reachable
 * leaf has a preimage. Equal durable-key and reachable-leaf counts rule out extras.
 */
export async function stagePortableResumeSemanticKeys(
  store: PortableStateResumeStore,
  staged: StagedPortableRecordState,
  batchSize = DEFAULT_PORTABLE_KEY_BATCH
): Promise<CompletedPortableStateStage> {
  if (!store.complete()) throw new Error("Portable state resume is incomplete");
  if (store.manifest.stateRoot !== staged.state.root()) throw new Error("Portable state semantic staging root mismatch");
  let importedKeyCount = 0;
  try {
    for await (const batch of streamPortableResumeKeys(store, batchSize)) {
      const parsed = batch.map(parseStateV2PortableKeyPreimage);
      await staged.nodeObjects.putSemanticKeys(parsed);
      importedKeyCount += parsed.length;
      if (importedKeyCount > store.manifest.keyCount) throw new Error("Portable state semantic staging exceeded manifest count");
    }
    if (importedKeyCount !== store.manifest.keyCount) throw new Error("Portable state semantic staging count mismatch");
    if (staged.nodeObjects.storedSemanticKeyCount() !== importedKeyCount) {
      throw new Error("Portable state semantic staging contains duplicate key preimages");
    }
    const counts = staged.nodeObjects.reachableCounts(staged.state, true);
    if (counts.nodes !== staged.importedRecordCount) {
      throw new Error("Portable state semantic staging changed authenticated node reachability");
    }
    if (counts.leaves !== importedKeyCount) {
      throw new Error("Portable state semantic staging contains extra or incomplete key preimages");
    }
    return { ...staged, importedKeyCount };
  } catch (error) {
    staged.nodeObjects.close();
    throw error;
  }
}
