import { createHash } from "node:crypto";

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

async function readCliCheckpointSnapshotBuffer(
  path: string,
  maxBytes: number,
  faultHooks: BoundedFileFaultHooks
): Promise<Buffer> {
  const body = await readBoundedFileBuffer(path, maxBytes, "CLI checkpoint snapshot", faultHooks);
  if (body.length < 1) throw new Error("CLI checkpoint snapshot must be non-empty");
  return body;
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
  const body = await readCliCheckpointSnapshotBuffer(path, maxBytes, faultHooks);
  assertBoundedCheckpointJsonStructure(body);
  return body.toString("utf8");
}

/**
 * Published checkpoint-install has an independently trusted snapshot digest.
 * ZyronChain defines that digest over canonicalJson(snapshot), while snapshot
 * files emitted by the CLI append one transport LF. Verify the canonical
 * payload bytes before structural scanning / UTF-8 materialization without
 * silently redefining --sha256 as a whole-file digest. subarray() is a view,
 * so stripping the optional writer LF does not allocate another snapshot copy.
 */
export async function readCliCheckpointSnapshotAnchoredUtf8(
  path: string,
  expectedSha256: string,
  maxBytes = CLI_CHECKPOINT_SNAPSHOT_MAX_BYTES,
  faultHooks: BoundedFileFaultHooks = {}
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("CLI checkpoint snapshot requires a lowercase 32-byte SHA-256 anchor");
  }
  const body = await readCliCheckpointSnapshotBuffer(path, maxBytes, faultHooks);
  const canonicalPayload = body[body.length - 1] === 0x0a ? body.subarray(0, body.length - 1) : body;
  if (canonicalPayload.length < 1) throw new Error("CLI checkpoint snapshot canonical payload must be non-empty");
  const actualSha256 = createHash("sha256").update(canonicalPayload).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error("CLI checkpoint snapshot SHA-256 mismatch");
  assertBoundedCheckpointJsonStructure(body);
  return body.toString("utf8");
}