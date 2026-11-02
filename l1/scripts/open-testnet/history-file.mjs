// Verified snapshot history on local disk (disk design for the 512 MB Render
// instance). The gateway's RAM holds only the tip height, tip hash and a
// running hash; every verified block is one NDJSON line,
// JSON.stringify(block), in a file that is truncated and rebuilt at every
// start (the free plan has no persistent disk, and contents from an earlier
// process are never trusted).
//
// Reads never trust the file either: each line is parsed on its own, must be
// the canonical JSON.stringify of what it parses to, must link to the line
// before it (verifySnapshotBlock: height, chain ID, previous hash, block
// hash, transaction root, unique txids), and at the requested tip the hash
// and the running hash (SHA-256 chain over every line) must match what the
// gateway appended. A truncated, corrupt or reordered file throws
// HistoryFileError (code history_file_corrupt); the gateway then rebuilds
// the file from validator history with full validation.
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { verifySnapshotBlock } from "./snapshot-verify.mjs";

export const HISTORY_MAX_LINE_BYTES = 32 * 1024 * 1024;
export class HistoryFileError extends Error {
  constructor(message) { super(`history file: ${message}`); this.name = "HistoryFileError"; this.code = "history_file_corrupt"; }
}
export function historySeed(genesisHash) { return createHash("sha256").update(`zyron-open-testnet-history\0${genesisHash}`).digest("hex"); }
export function nextRunningHash(previous, line) { return createHash("sha256").update(previous).update("\n").update(line).digest("hex"); }

async function writeAll(handle, buffer) {
  for (let offset = 0; offset < buffer.length;) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (!(bytesWritten > 0)) throw new Error("history file write made no progress");
    offset += bytesWritten;
  }
}

// Creates (truncates) the history file. append() checks linkage again before
// writing (the caller has already run full finalized-block validation) and
// only advances the in-RAM tip after the line is completely written.
// Symlinks are refused (lstat on the directory, O_NOFOLLOW on the file), the
// directory is forced to 0700 and the file to 0600.
const WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new HistoryFileError("history directory is not a plain directory");
  await chmod(dir, 0o700);
}
// Refuses a file with more than one hard link (checked on the open handle, so
// a link created between lstat and open is caught too).
async function refuseHardLink(handle) {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink > 1) throw new HistoryFileError("history path is a hard link");
}
async function openForWrite(path) {
  const existing = await lstat(path).catch((error) => { if (error?.code === "ENOENT") return undefined; throw error; });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new HistoryFileError("history path is not a regular file");
  // A hard link would let O_TRUNC and later writes reach another name.
  if (existing && existing.nlink > 1) throw new HistoryFileError("history path is a hard link");
  let handle;
  try { handle = await open(path, WRITE_FLAGS, 0o600); } catch (error) { if (error?.code === "ELOOP") throw new HistoryFileError("history path is a symlink"); throw error; }
  try { await refuseHardLink(handle); } catch (error) { await handle.close().catch(() => {}); throw error; }
  await handle.chmod(0o600);
  return handle;
}
export async function createHistoryFile(path, { chainId, genesisHash }) {
  await ensurePrivateDir(dirname(path));
  let handle = await openForWrite(path);
  const state = { height: 0, tipHash: genesisHash, runningHash: historySeed(genesisHash), broken: undefined };
  let queue = Promise.resolve();
  const serial = (task) => { const run = queue.then(task); queue = run.then(() => undefined, () => undefined); return run; };
  async function appendBlocks(blocks) {
    if (state.broken) throw new HistoryFileError(`unusable after an earlier write failure (${state.broken})`);
    let { height, tipHash, runningHash } = state;
    const lines = [];
    for (const block of blocks) {
      const line = JSON.stringify(block);
      tipHash = verifySnapshotBlock(block, { height: height + 1, previous: tipHash, chainId });
      height += 1; runningHash = nextRunningHash(runningHash, line);
      lines.push(line);
    }
    if (!lines.length) return;
    try { await writeAll(handle, Buffer.from(`${lines.join("\n")}\n`)); } catch (error) { state.broken = error instanceof Error ? error.message : String(error); throw error; }
    state.height = height; state.tipHash = tipHash; state.runningHash = runningHash;
  }
  return {
    path,
    append: (block) => serial(() => appendBlocks([block])),
    appendMany: (blocks) => serial(() => appendBlocks(blocks)),
    height: () => state.height,
    tipHash: () => state.tipHash,
    // What a reader needs to validate the file up to the current tip.
    view: () => ({ path, tip: state.height, tipHash: state.tipHash, runningHash: state.runningHash, chainId, genesisHash }),
    reset: () => serial(async () => {
      await handle.close().catch(() => {});
      handle = await openForWrite(path);
      state.height = 0; state.tipHash = genesisHash; state.runningHash = historySeed(genesisHash); state.broken = undefined;
    }),
    close: () => serial(() => handle.close().catch(() => {}))
  };
}

// Yields the first `tip` lines (each exactly JSON.stringify(block)) after
// validating them; reads in chunks, so memory stays at one line plus a chunk.
export async function* readHistoryLines({ path, tip, tipHash, runningHash, chainId, genesisHash }, { signal, maxLineBytes = HISTORY_MAX_LINE_BYTES } = {}) {
  if (!(Number.isSafeInteger(tip) && tip >= 0)) throw new HistoryFileError("invalid tip");
  let height = 0; let previous = genesisHash; let running = historySeed(genesisHash);
  let carry = [];
  let carryBytes = 0;
  const check = (bytes) => {
    const line = bytes.toString("utf8");
    let block;
    try { block = JSON.parse(line); } catch { throw new HistoryFileError(`line ${height + 1} is not JSON`); }
    if (JSON.stringify(block) !== line) throw new HistoryFileError(`line ${height + 1} is not canonical`);
    try { previous = verifySnapshotBlock(block, { height: height + 1, previous, chainId }); } catch (error) { throw new HistoryFileError(error instanceof Error ? error.message : String(error)); }
    height += 1; running = nextRunningHash(running, line);
    return line;
  };
  if (tip > 0) {
    let readHandle;
    try { readHandle = await open(path, READ_FLAGS); } catch (error) { throw new HistoryFileError(error?.code === "ELOOP" ? "history path is a symlink" : `read failed (${error?.code ?? "io"})`); }
    try { await refuseHardLink(readHandle); } catch (error) { await readHandle.close().catch(() => {}); throw error instanceof HistoryFileError ? error : new HistoryFileError(`read failed (${error?.code ?? "io"})`); }
    const stream = readHandle.createReadStream({ highWaterMark: 256 * 1024, autoClose: false });
    try {
      outer: for await (const chunk of stream) {
        if (signal?.aborted) throw Object.assign(new Error("snapshot build aborted"), { code: "aborted" });
        let start = 0;
        for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
          const piece = chunk.subarray(start, index);
          const bytes = carry.length ? Buffer.concat([...carry, piece]) : piece;
          carry = []; carryBytes = 0; start = index + 1;
          if (bytes.length > maxLineBytes) throw new HistoryFileError(`line ${height + 1} is too long`);
          yield check(bytes);
          if (height === tip) break outer;
        }
        if (start < chunk.length) {
          carry.push(chunk.subarray(start)); carryBytes += chunk.length - start;
          if (carryBytes > maxLineBytes) throw new HistoryFileError(`line ${height + 1} is too long`);
        }
      }
    } catch (error) {
      if (error instanceof HistoryFileError || error?.code === "aborted") throw error;
      throw new HistoryFileError(`read failed (${error?.code ?? "io"})`);
    } finally {
      stream.destroy();
      await readHandle.close().catch(() => {});
    }
  }
  if (height !== tip) throw new HistoryFileError(`truncated: ${height} of ${tip} lines`);
  if (previous !== tipHash) throw new HistoryFileError("does not end at the expected tip");
  if (running !== runningHash) throw new HistoryFileError("running hash mismatch");
}
