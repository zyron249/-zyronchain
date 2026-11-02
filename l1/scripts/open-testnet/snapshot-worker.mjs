// Snapshot build worker (worker_thread). The gateway's event loop only
// collects and validates new blocks (yielding between blocks); the
// whole-chain work runs here: the final linkage check
// (verifySnapshotBlocks), JSON serialisation, gzip and AES-256-GCM sealing.
//
// Protocol (parent -> worker):
//   { type: "append", blocks }  verified blocks, in order, after the ones
//                               already sent (the worker keeps a copy, so
//                               each build only ships the new blocks)
//   { type: "build", id, tip, tipHash, chainId, genesisHash, genesis,
//     network, keys, createdAtMs }
// worker -> parent:
//   { type: "built", id, height, sealed }  (sealed: transferred ArrayBuffer)
//   { type: "failed", id, error }          (message only, never a stack)
//
// The state secret arrives once in workerData and is only passed to
// sealSnapshot. Nothing here logs; error messages are sanitised again by the
// parent before they reach logs or /health.
import { parentPort, workerData } from "node:worker_threads";
import { SNAPSHOT_MAGIC, sealSnapshot } from "./snapshot-seal.mjs";
import { verifySnapshotBlocks } from "./snapshot-verify.mjs";

const secret = workerData?.secret;
const blocks = [];

parentPort.on("message", (message) => {
  if (message?.type === "append") {
    for (const block of message.blocks) blocks.push(block);
    return;
  }
  if (message?.type !== "build") return;
  const { id, tip, tipHash, chainId, genesisHash, genesis, network, keys, createdAtMs } = message;
  try {
    if (!(Number.isSafeInteger(tip) && tip >= 1 && tip <= blocks.length)) throw new Error(`snapshot worker holds ${blocks.length} blocks, cannot build tip ${tip}`);
    const history = blocks.slice(0, tip);
    verifySnapshotBlocks(history, { tip, tipHash, chainId, genesisHash });
    const sealed = sealSnapshot({ format: SNAPSHOT_MAGIC, createdAtMs, genesis, network, keys, blocks: history }, secret);
    const buffer = sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength);
    parentPort.postMessage({ type: "built", id, height: tip, sealed: buffer }, [buffer]);
  } catch (error) {
    parentPort.postMessage({ type: "failed", id, error: error instanceof Error ? error.message : String(error) });
  }
});
