import { readBoundedFileBuffer, readBoundedUtf8File, type BoundedFileFaultHooks } from "./bounded-file.js";
import { assertBoundedCheckpointJsonStructure } from "./checkpoint-json-complexity.js";
import { readBoundedRegularControlFile } from "./control-file.js";

/** Keep operator-supplied genesis files bounded like the packaged miner. */
export const CLI_GENESIS_MAX_BYTES = 256 * 1024;

/** Keep local checkpoint install aligned with the canonical P2P snapshot ceiling. */
export const CLI_CHECKPOINT_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

export async function readCliGenesisUtf8(path: string): Promise<string> {
  return readBoundedRegularControlFile(path, "CLI genesis file", CLI_GENESIS_MAX_BYTES);
}

/**
 * Trusted checkpoint snapshots can legitimately be large, but the canonical
 * checkpoint transport already caps a full snapshot at 64 MiB. Reuse the
 * hardened bounded local-state reader so local installs cannot bypass that
 * resource boundary or the Windows post-open/post-read pathname checks.
 * Structural complexity is checked on the already bounded bytes before UTF-8
 * materialization so JSON.parse cannot allocate a pathological object graph.
 */
export async function readCliCheckpointSnapshotUtf8(
  path: string,
  maxBytes = CLI_CHECKPOINT_SNAPSHOT_MAX_BYTES,
  faultHooks: BoundedFileFaultHooks = {}
): Promise<string> {
  const body = await readBoundedFileBuffer(path, maxBytes, "CLI checkpoint snapshot", faultHooks);
  if (body.length < 1) throw new Error("CLI checkpoint snapshot must be non-empty");
  assertBoundedCheckpointJsonStructure(body);
  return body.toString("utf8");
}
