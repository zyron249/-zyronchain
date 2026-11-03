// Verified gateway checkpoint (#1193, opt-in with ZYRON_CHECKPOINT=1).
//
// After a restart the gateway re-validates its whole history file (#1192),
// which costs ~28 min on the 0.1-CPU host. A checkpoint stores the verified
// chain state at one history height next to history.ndjson, so a restart can
// skip validating the blocks below it. It is a speed-up only and is never
// trusted on its own:
//   - the file carries a SHA-256 over its body and stateHash over the state;
//     both only catch torn or corrupt files (no HMAC: a same-uid attacker
//     can read any key the gateway holds, so trust comes from verification);
//   - the history line at the checkpoint height must be byte-equal to the
//     stored line, and the history running hash there must match;
//   - before anything from the checkpoint is used, the live validators must
//     serve the checkpoint tip hash at that height (checkResumedTail rule);
//   - the state is loaded with ZyronChain.fromTrustedSnapshot (state root,
//     proposer signature and finality certificate of the tip), the tip must
//     run on state v2 (validator, protocol and oracle schedules are bound by
//     the state root), and the supply must reconcile against genesis;
//   - the blocks after it are validated in full (acceptBlock).
// Any failure discards the checkpoint and the gateway re-validates the
// history from genesis.
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dist = (name) => join(l1Root, "dist/src", name);
const { canonicalJson } = await import(dist("codec.js"));
const { assertBoundedCheckpointJsonStructure } = await import(dist("checkpoint-json-complexity.js"));
const { ZyronChain, protocolUsesStateV2 } = await import(dist("chain.js"));
const { supplyReport } = await import(dist("supply-report.js"));
const { spendableAtoms } = await import(dist("allocation-locks.js"));
const { validateBlockEnvelope } = await import(dist("block.js"));
const { historySeed, nextRunningHash, resumeHistoryFile } = await import("./history-file.mjs");

export const CHECKPOINT_MAGIC = "zyron-gateway-checkpoint";
export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_MAX_BYTES = 32 * 1024 * 1024;
export const CHECKPOINT_EVERY_BLOCKS = 500;
export const CHECKPOINT_EVERY_MS = 10 * 60_000;
export const CHECKPOINT_FILE = "checkpoint.json";
const TMP_PREFIX = `${CHECKPOINT_FILE}.tmp.`;
const RECORD_KEYS = ["magic", "version", "chainId", "genesisHash", "height", "tipHash", "historyRunningHash", "historyLine", "stateHash", "state"];
const SNAPSHOT_KEYS = { 1: ["version", "chainId", "genesisHash", "height", "tip", "state", "validatorSchedule", "protocolSchedule"] };
SNAPSHOT_KEYS[2] = [...SNAPSHOT_KEYS[1], "activityOracleGovernance"];
const HEX64 = /^[0-9a-f]{64}$/;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export class CheckpointError extends Error {
  constructor(message) { super(`checkpoint: ${message}`); this.name = "CheckpointError"; this.code = "checkpoint_rejected"; }
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new CheckpointError(message); };

// Env flag read in code (default OFF). Interval overrides exist for tests.
export function parseCheckpointOptions(env = process.env) {
  const positive = (value, fallback) => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : fallback; };
  return {
    enabled: env.ZYRON_CHECKPOINT === "1",
    everyBlocks: positive(env.ZYRON_CHECKPOINT_EVERY_BLOCKS, CHECKPOINT_EVERY_BLOCKS),
    everyMs: positive(env.ZYRON_CHECKPOINT_EVERY_MS, CHECKPOINT_EVERY_MS)
  };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not an object`);
  const have = Object.keys(value);
  if (have.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) fail(`${label} has unexpected keys`);
}

// Encodes a checkpoint: canonical JSON body, newline, SHA-256(body), newline.
export function encodeCheckpoint({ chainId, genesisHash, height, tipHash, historyRunningHash, historyLine, state }) {
  const stateJson = canonicalJson(state);
  const record = { magic: CHECKPOINT_MAGIC, version: CHECKPOINT_VERSION, chainId, genesisHash, height, tipHash, historyRunningHash, historyLine, stateHash: sha256(stateJson), state };
  const body = canonicalJson(record);
  return Buffer.from(`${body}\n${sha256(body)}\n`);
}

// Checks integrity and shape only (no trust): size cap, digest, the existing
// checkpoint JSON complexity limits, canonical bytes, exact keys (nothing
// outside ChainSnapshot), identity, stateHash.
export function decodeCheckpoint(bytes, { chainId, genesisHash, maxBytes = CHECKPOINT_MAX_BYTES }) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > maxBytes) fail("file is over the size cap");
  if (bytes.length < 67 || bytes[bytes.length - 1] !== 10 || bytes[bytes.length - 66] !== 10) fail("file is truncated");
  const digest = bytes.subarray(bytes.length - 65, bytes.length - 1).toString("latin1");
  const bodyBytes = bytes.subarray(0, bytes.length - 66);
  if (!HEX64.test(digest) || sha256(bodyBytes) !== digest) fail("digest mismatch");
  try { assertBoundedCheckpointJsonStructure(bodyBytes); } catch { fail("JSON complexity exceeded"); }
  const body = bodyBytes.toString("utf8");
  let record;
  try { record = JSON.parse(body); } catch { fail("body is not JSON"); }
  let canonical;
  try { canonical = canonicalJson(record); } catch { fail("body is not canonical"); }
  if (canonical !== body) fail("body is not canonical");
  exactKeys(record, RECORD_KEYS, "record");
  if (record.magic !== CHECKPOINT_MAGIC || record.version !== CHECKPOINT_VERSION) fail("wrong magic or version");
  if (record.chainId !== chainId || record.genesisHash !== genesisHash) fail("chain ID or genesis mismatch");
  if (!Number.isSafeInteger(record.height) || record.height < 1) fail("invalid height");
  for (const key of ["tipHash", "historyRunningHash", "stateHash"]) if (typeof record[key] !== "string" || !HEX64.test(record[key])) fail(`invalid ${key}`);
  if (typeof record.historyLine !== "string") fail("invalid history line");
  const version = record.state?.version;
  if (!SNAPSHOT_KEYS[version]) fail("state is not a ChainSnapshot");
  exactKeys(record.state, SNAPSHOT_KEYS[version], "state");
  if (sha256(canonicalJson(record.state)) !== record.stateHash) fail("stateHash mismatch");
  if (record.state.height !== record.height || record.state.tip?.hash !== record.tipHash || record.state.chainId !== chainId || record.state.genesisHash !== genesisHash) fail("state does not match the record");
  let line;
  try { line = JSON.parse(record.historyLine); } catch { fail("history line is not JSON"); }
  if (JSON.stringify(line) !== record.historyLine || line?.hash !== record.tipHash || line?.header?.height !== record.height) fail("history line does not match the tip");
  return record;
}

// Same file rules as history-file.mjs: regular file, O_NOFOLLOW, one link,
// size cap checked on the handle.
export async function readCheckpoint(path, { chainId, genesisHash, maxBytes = CHECKPOINT_MAX_BYTES }) {
  const info = await lstat(path).catch((error) => { if (error?.code === "ENOENT") return undefined; throw error; });
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) fail("path is not a regular file");
  if (info.nlink > 1) fail("path is a hard link");
  if (info.size > maxBytes) fail("file is over the size cap");
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0)); } catch (error) { fail(error?.code === "ELOOP" ? "path is a symlink" : `open failed (${error?.code ?? "io"})`); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1) fail("path is not a single-link regular file");
    if (opened.size > maxBytes) fail("file is over the size cap");
    const bytes = Buffer.alloc(opened.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail("file shrank while reading");
      offset += bytesRead;
    }
    return decodeCheckpoint(bytes, { chainId, genesisHash, maxBytes });
  } finally { await handle.close().catch(() => {}); }
}

// Atomic write: O_EXCL|O_NOFOLLOW 0600 tmp file, fsync, rename, directory
// fsync. `beforeRename` is a test hook (crash between write and rename).
export async function writeCheckpoint(path, bytes, { maxBytes = CHECKPOINT_MAX_BYTES, beforeRename } = {}) {
  if (bytes.length > maxBytes) fail(`state is ${bytes.length} bytes, over the ${maxBytes}-byte cap; not written`);
  const dir = dirname(path);
  const tmp = join(dir, `${TMP_PREFIX}${process.pid}`);
  const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  let renamed = false;
  try {
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!(bytesWritten > 0)) throw new Error("checkpoint write made no progress");
      offset += bytesWritten;
    }
    await handle.sync();
    await handle.close();
    if (beforeRename) await beforeRename(tmp);
    await rename(tmp, path);
    renamed = true;
    const dirHandle = await open(dir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch (error) {
    await handle.close().catch(() => {});
    if (!renamed) await unlink(tmp).catch(() => {});
    throw error;
  }
  return bytes.length;
}

// Boot: removes leftover tmp files. unlink never follows a symlink (a link
// named like a tmp file is removed itself, its target is untouched);
// directories are left alone.
export async function cleanStaleCheckpointTmp(dir) {
  let names;
  try { names = await readdir(dir); } catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const info = await lstat(join(dir, name)).catch(() => undefined);
    if (!info || info.isDirectory()) continue;
    await unlink(join(dir, name)).catch(() => {}); removed += 1;
  }
  return removed;
}
export async function discardCheckpoint(path) { await unlink(path).catch(() => {}); }
export const isCheckpointTmpName = (name) => basename(name).startsWith(TMP_PREFIX);

// Supply after load: total = genesis supply, balances + burned = total with
// burned >= 0 (fees are burned, nothing mints), locked amounts from the
// GENESIS allocation-lock schedule (chain.genesis is the local genesis.json,
// never the checkpoint) within each balance. Same reconciliation as the
// pinned tools/supply-verifier (supply-report.ts).
export function checkChainSupply(chain, genesis) {
  const expected = new ZyronChain(genesis).genesisSupplyAtoms();
  if (chain.genesisSupplyAtoms() !== expected) fail("genesis supply mismatch");
  const locks = chain.allocationLocksAt(chain.tip.header.timestampMs);
  let report;
  try {
    report = supplyReport({
      height: chain.height, tipHash: chain.tip.hash,
      genesisSupplyAtoms: () => expected,
      accounts: () => chain.getState().snapshot().accounts,
      lockedAtoms: (address, balanceAtoms) => balanceAtoms - spendableAtoms(locks, address, balanceAtoms)
    });
  } catch (error) { fail(`supply check failed (${error instanceof Error ? error.message : String(error)})`); }
  if (!report.reconciles || BigInt(report.totalSupplyAtoms) !== BigInt(expected)) fail("supply does not reconcile with genesis and burns");
  if (BigInt(report.balancesAtoms) + BigInt(report.burnedAtoms) !== BigInt(expected)) fail("balances plus burns differ from genesis supply");
  return report;
}

// Loads the checkpoint state. Call ONLY after the live tip match. The tip
// must run on state v2 so the schedules are bound by its state root.
export async function loadCheckpointChain(genesis, record, { onStep } = {}) {
  let chain;
  try {
    chain = await ZyronChain.fromTrustedSnapshotInSteps(genesis, structuredClone(record.state), { tipHash: record.tipHash, snapshotSha256: record.stateHash }, onStep);
  } catch (error) { fail(`state rejected (${error instanceof Error ? error.message : String(error)})`); }
  if (chain.height !== record.height || chain.tip.hash !== record.tipHash) fail("loaded chain tip mismatch");
  if (!protocolUsesStateV2(chain.protocolVersionAt(chain.height))) fail("tip is not on state v2");
  checkChainSupply(chain, genesis);
  return chain;
}

// Prefix signature check (#1197 Security Low): the blocks at or below the
// checkpoint are not replayed through the state transition, but each one
// still gets the full finalized-block envelope check acceptBlock applies
// (structure, hash link to the previous block, expected proposer, proposer
// signature, round/finality certificates with the attestation signatures,
// and every transaction signature) against the validator set and protocol
// version the loaded checkpoint chain reports for that height. Those
// schedules are bound by the state root, which the live tip match anchors,
// so an attestation edited below the checkpoint (with the checkpoint
// resealed) fails here and the caller rebuilds from genesis.
// Call ONLY after loadCheckpointChain. Returns a checker fed one block at a
// time in height order from 1 to record.height.
export function createPrefixVerifier(chain, genesis, record, { nowMs = Date.now() } = {}) {
  let previous = new ZyronChain(genesis).tip;
  return {
    check(block) {
      const height = previous.header.height + 1;
      if (height > record.height) fail("prefix check past the checkpoint height");
      if (block?.header?.height !== height) fail(`prefix block ${height} out of order`);
      try {
        validateBlockEnvelope(block, previous, chain.validatorsAt(height), nowMs, true, chain.protocolVersionAt(height));
      } catch (error) { fail(`prefix block ${height} rejected (${error instanceof Error ? error.message : String(error)})`); }
      if (height === record.height && block.hash !== record.tipHash) fail("prefix does not end at the checkpoint tip");
      previous = block;
    },
    done() { if (previous.header.height !== record.height) fail(`prefix ends at ${previous.header.height}, checkpoint at ${record.height}`); }
  };
}

// Boot scan: resumes the history file (every line re-checked by
// resumeHistoryFile) WITHOUT replaying the blocks, and requires the line at
// the checkpoint height to be byte-equal to the stored line and the running
// hash there to match. Throws (and leaves the file for the full replay) on
// any mismatch or when the checkpoint is above the history tip.
export async function resumeHistoryAtCheckpoint(historyPath, record, { chainId, genesisHash, signal }) {
  let running = historySeed(genesisHash); let matched = false;
  const resumed = await resumeHistoryFile(historyPath, {
    chainId, genesisHash, signal,
    onBlock: (block, height) => {
      if (height > record.height) return;
      const line = JSON.stringify(block);
      running = nextRunningHash(running, line);
      if (height === record.height) {
        if (line !== record.historyLine) fail("history line differs from the checkpoint");
        if (running !== record.historyRunningHash) fail("history running hash differs from the checkpoint");
        matched = true;
      }
    }
  });
  if (!matched) { await resumed.file.close(); fail(`height ${record.height} is above the history tip ${resumed.height}`); }
  // The main thread's own view of the prefix, compared with the worker's.
  resumed.prefixView = { height: record.height, runningHash: running };
  return resumed;
}
