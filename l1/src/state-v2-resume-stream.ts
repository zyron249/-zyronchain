import { MAX_PORTABLE_STATE_KEYS, MAX_PORTABLE_STATE_NODES } from "./state-v2-portable.js";
import { PortableStateResumeStore } from "./state-v2-resume.js";

export const DEFAULT_PORTABLE_RECORD_BATCH = 128;
export const DEFAULT_PORTABLE_KEY_BATCH = 1_024;

/**
 * Consume a complete portable State-v2 resume store without assembling one
 * records[] array in memory. Each yielded batch is independently bounded.
 */
export async function* streamPortableResumeRecords(
  store: PortableStateResumeStore,
  batchSize = DEFAULT_PORTABLE_RECORD_BATCH
): AsyncGenerator<unknown[], void, void> {
  validateBatchSize(batchSize, MAX_PORTABLE_STATE_NODES, "record");
  if (!store.complete()) throw new Error("Portable state resume is incomplete");
  for (let start = 0; start < store.manifest.recordCount; start += batchSize) {
    const limit = Math.min(batchSize, store.manifest.recordCount - start);
    yield await store.records(start, limit);
  }
}

/**
 * Consume semantic-key preimages in bounded batches. The caller remains
 * responsible for authenticated-root/reachability validation before publish.
 */
export async function* streamPortableResumeKeys(
  store: PortableStateResumeStore,
  batchSize = DEFAULT_PORTABLE_KEY_BATCH
): AsyncGenerator<unknown[], void, void> {
  validateBatchSize(batchSize, MAX_PORTABLE_STATE_KEYS, "key");
  if (!store.complete()) throw new Error("Portable state resume is incomplete");
  for (let start = 0; start < store.manifest.keyCount; start += batchSize) {
    const limit = Math.min(batchSize, store.manifest.keyCount - start);
    yield await store.keys(start, limit);
  }
}

function validateBatchSize(value: number, absoluteMax: number, kind: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > absoluteMax) {
    throw new Error(`Invalid portable state ${kind} stream batch size`);
  }
}
