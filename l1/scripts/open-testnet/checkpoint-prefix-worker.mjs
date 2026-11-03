// Boot-time prefix verifier (#1197 option a), run in ONE worker thread.
// It reads the checkpoint and the history file itself, loads the checkpoint
// chain (state root, state v2, supply) only to get the per-height validator
// set and protocol version, and runs createPrefixVerifier over every line up
// to the checkpoint height (proposer signature, finality certificate with
// every attestation, every transaction signature). It returns the height and
// the running hash over the exact bytes it checked; the main thread accepts
// the pass only if they equal the checkpoint record and its own scan, and
// only after the live tip match and its own state-root load. workerData holds
// paths, ids and the public genesis only; the worker runs with env {}.
import { parentPort, workerData } from "node:worker_threads";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { createPrefixVerifier, loadCheckpointChain, readCheckpoint } from "./checkpoint-file.mjs";
import { HISTORY_MAX_LINE_BYTES, historySeed, nextRunningHash } from "./history-file.mjs";

const { historyPath, checkpointPath, chainId, genesisHash, genesis } = workerData;
const yieldNow = () => new Promise((done) => setImmediate(done));

async function run() {
  const record = await readCheckpoint(checkpointPath, { chainId, genesisHash });
  if (!record) throw new Error("no checkpoint");
  const chain = await loadCheckpointChain(genesis, record);
  const verifier = createPrefixVerifier(chain, genesis, record);
  let height = 0; let running = historySeed(genesisHash); let tipHash;
  const handle = await open(historyPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).nlink > 1) throw new Error("history path is a hard link");
    const stream = handle.createReadStream({ highWaterMark: 256 * 1024, autoClose: false });
    let carry = []; let carryBytes = 0;
    try {
      outer: for await (const chunk of stream) {
        let start = 0;
        for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
          const piece = chunk.subarray(start, index);
          const bytes = carry.length ? Buffer.concat([...carry, piece]) : piece;
          carry = []; carryBytes = 0; start = index + 1;
          if (bytes.length > HISTORY_MAX_LINE_BYTES) throw new Error(`line ${height + 1} is too long`);
          const line = bytes.toString("utf8");
          const block = JSON.parse(line);
          if (JSON.stringify(block) !== line) throw new Error(`line ${height + 1} is not canonical`);
          verifier.check(block);
          height += 1; running = nextRunningHash(running, line); tipHash = block.hash;
          if (height % 200 === 0) await yieldNow();
          if (height === record.height) break outer;
        }
        if (start < chunk.length) {
          carry.push(Buffer.from(chunk.subarray(start))); carryBytes += chunk.length - start;
          if (carryBytes > HISTORY_MAX_LINE_BYTES) throw new Error(`line ${height + 1} is too long`);
        }
      }
    } finally { stream.destroy(); }
  } finally { await handle.close().catch(() => {}); }
  verifier.done();
  return { ok: true, height, runningHash: running, tipHash, stateHash: record.stateHash, envKeyCount: Object.keys(process.env).length };
}

run().then(
  (result) => parentPort.postMessage(result),
  (error) => parentPort.postMessage({ ok: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) })
);
