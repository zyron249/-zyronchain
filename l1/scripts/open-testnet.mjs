#!/usr/bin/env node
// ZyronChain open TESTNET: four loopback validators on consensus protocol v6,
// a fixed-supply-v1 genesis built only from freshly generated TEST keys, and a
// public gateway (read API, transfer submit, rate-limited faucet, block
// explorer, health). Test ZYN has no value. This profile never reads, derives
// or touches any mainnet key, allocation or genesis.
//
//   node scripts/open-testnet.mjs init --dir <secret dir> [--chain-id <id>]
//   node scripts/open-testnet.mjs run  --dir <secret dir> [--port 10000] [--host 127.0.0.1] [--init-if-missing]
//   node scripts/open-testnet.mjs smoke            (disposable end-to-end check)
//
// Persistence for hosts without a disk: with ZYRON_TESTNET_STATE_SECRET set, the
// gateway serves GET /state/snapshot, an AES-256-GCM sealed bundle (genesis,
// TEST keys, finalized blocks). `run --init-if-missing --restore-url <url>`
// restores a missing directory from such a bundle (re-validating every block)
// before falling back to a fresh genesis.
//
// Startup on hosts with a port scan (Render): the gateway binds --port / $PORT
// before anything slow happens. While the snapshot is downloaded, decrypted and
// replayed, GET /health answers 200 {status:"starting", phase} so the platform
// health check passes, /readyz answers 503, and every other endpoint answers 503
// until the validators are serving.
//
// <secret dir> holds plaintext TEST validator/faucet keys (mode 0600) and the
// chain data. It must live outside the repository and must never be shared.
import { activeSetSeedFromHistory, createActiveSetTracker } from "./gateway-quorum.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { createReadStream, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = (name) => join(l1Root, "dist/src", name);
const { ZyronChain } = await import(dist("chain.js"));
const { ChainStore } = await import(dist("storage.js"));
const { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } = await import(dist("crypto.js"));
const { createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer } = await import(dist("transaction.js"));
const { blockHash, expectedValidator } = await import(dist("block.js"));
const { merkleRoot } = await import(dist("merkle.js"));
const { canonicalJson } = await import(dist("codec.js"));
const { fixedSupplyPlanAtoms, FIXED_SUPPLY_LAUNCH_PROFILE } = await import(dist("tokenomics.js"));
const { defaultPublicDistributionRelease } = await import(dist("public-distribution-release.js"));
const { MEMPOOL_MIN_FEE_ENV, nodeTransferFeeAtoms, parseMempoolMinFeeAtoms } = await import(dist("mempool.js"));
const { STRICT_MIN_VALIDATORS } = await import(dist("network-class.js"));
const { gatewayClientIdentity } = await import(dist("rpc-client-identity.js"));
const { ConsensusRelay, RELAY_MAX_BODY_BYTES, RELAY_MAX_CONSENSUS_REQUEST_BYTES, parseRelayPeers, relayReplyHeaders, relayVotingPeer } = await import("./open-testnet/consensus-relay.mjs");

export const DEFAULT_CHAIN_ID = "zyron-open-testnet-1";
const VALIDATOR_NAMES = ["v1", "v2", "v3", "v4"];
// Entries that initNetwork / restoreNetwork create in a network directory
// (network.json.partial is the completion marker before its atomic rename).
const NETWORK_DIR_ENTRIES = new Set(["keys", "genesis.json", "network.json", "network.json.partial", ...VALIDATOR_NAMES.map((name) => `data-${name}`)]);

// network.json is the completion marker: restoreNetwork and initNetwork write it
// last, through a temporary file that is fsynced and renamed into place, so it
// is either absent or complete. A directory only counts as a usable network if
// the marker is a network description the gateway can run with (chain ID,
// genesis hash, faucet address matching keys/faucet.json, TEST chain ID) and
// describes this directory's genesis.json;
// anything else (missing, torn by an older non-atomic write, edited, or for
// another genesis) is incomplete. Returns the parsed marker or null.
export async function readNetworkMarker(dir) {
  const readJson = async (name) => {
    let text;
    try { text = await readFile(join(dir, name), "utf8"); } catch (error) { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined; throw error; }
    try { return JSON.parse(text); } catch { return undefined; }
  };
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const info = await readJson("network.json");
  if (!isObject(info) || typeof info.chainId !== "string" || typeof info.genesisHash !== "string" || typeof info.faucetAddress !== "string") return null;
  const genesis = await readJson("genesis.json");
  if (!isObject(genesis) || genesis.chainId !== info.chainId) return null;
  try { if (new ZyronChain(genesis).genesisHash !== info.genesisHash) return null; } catch { return null; }
  // The remaining runNetwork preconditions: a TEST chain ID and a faucet key
  // whose address is the marker's faucetAddress.
  try {
    assertTestnetChainId(genesis.chainId);
    const faucetKey = (await readSecret(join(dir, "keys", "faucet.json"))).privateKey;
    if (addressFromPublicKey(publicKeyFromPrivate(faucetKey)) !== info.faucetAddress) return null;
  } catch { return null; }
  return info;
}

async function writeNetworkMarker(dir, value) {
  const marker = join(dir, "network.json");
  if (await lstat(marker).then(() => true, () => false)) throw Object.assign(new Error(`${marker} already exists`), { code: "EEXIST" });
  const partial = `${marker}.partial`;
  const handle = await open(partial, "w", 0o644);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(partial, marker);
}

// A directory without a valid completion marker is an interrupted restore or
// init (for example a host restart in the middle of a replay, or a crash while
// network.json was written). Move it aside to <dir>.incomplete-<ms>-<pid>/<name>
// (never delete it) so the next attempt starts clean; a directory holding
// top-level entries those steps do not create is refused and left untouched.
// An existing path is never replaced. Returns the new path, or false if nothing
// was moved. Afterwards only the newest MAX_INCOMPLETE_HOLDERS holders are kept
// (see pruneIncompleteHolders); the directory just moved is never pruned.
export async function moveAsideIncompleteNetworkDir(dir, { removeHolder, reserveHolder = (path) => mkdir(path, { mode: 0o700 }), afterInspect, readMountPoints, isProcessAlive, log = (line) => console.error(line) } = {}) {
  let entries;
  try { entries = await readdir(dir); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (await readNetworkMarker(dir)) return false;
  const unexpected = entries.filter((name) => !NETWORK_DIR_ENTRIES.has(name));
  if (unexpected.length) throw new Error(`refusing to move ${dir}: unexpected entries ${unexpected.join(", ")}`);
  // The holder directory is reserved with an exclusive mkdir (an existing path
  // is skipped, never replaced); the directory then moves into it under its
  // own name, a path nothing else can have created.
  // Old holders are pruned first, down to room for the new one, so a disk
  // filled by earlier attempts can free space before the reservation.
  // Room is reserved only for a directory that will count toward the bound
  // once moved (R24-1048-I1-F1): one with an operator file below an allowed
  // entry, or a mount point, will be kept and not counted, so it must not cost
  // an older prunable holder. An inspection failure reserves the room.
  let incomingCounts = true;
  try {
    incomingCounts = await isTestnetCreatedNetworkDir(dir) && !(await holderHasMountPoint(dir, readMountPoints ?? readMountPointsFromProc));
  } catch { incomingCounts = true; }
  await pruneIncompleteHolders(dir, { keep: incomingCounts ? MAX_INCOMPLETE_HOLDERS - 1 : MAX_INCOMPLETE_HOLDERS, removeHolder, afterInspect, readMountPoints, isProcessAlive, log });
  // The name keeps creation order even if the wall clock moved back: its time
  // is never below the newest existing holder's, and at an equal time the
  // counter goes past that holder's (order is time, then counter, then pid).
  const { ms, next } = await nextHolderOrder(dir, Date.now());
  for (const holder of holderNames(dir, ms, next)) {
    try { await reserveHolder(holder); } catch (error) { if (error?.code === "EEXIST") continue; throw error; }
    const aside = join(holder, basename(dir));
    await rename(dir, aside);
    await pruneIncompleteHolders(dir, { exclude: holder, removeHolder, afterInspect, readMountPoints, isProcessAlive, log });
    return aside;
  }
  throw new Error(`refusing to move ${dir}: no free name next to it`);
}

// R24-1048-I1: retention bound for moved-aside holders. Holders are TEST data
// only (no value), but a host that keeps failing restores on the same disk
// would otherwise keep one partial network per attempt. Only the newest
// MAX_INCOMPLETE_HOLDERS (including the one just created) are kept. An older
// holder is removed only if it is exactly what move-aside creates: a real
// directory named <dir>.incomplete-<ms>-<pid>[-<n>] next to <dir>, holding only
// a real directory named like <dir>, whose top-level entries are ones the open
// testnet creates, whose keys/ holds only the key files the testnet writes, whose
// data-<validator>/ directories hold only the files a validator store writes
// (and consensus-state/ only consensus-state files), with no symlink or special
// file anywhere inside. Anything else (an operator note, a foreign name or
// layout) is never removed and does not count toward the bound. Old holders are
// pruned before the new one is reserved and again after the move. Names keep
// creation order across clock rollbacks (see nextHolderOrder), and a holder is
// removed only if it is unchanged since inspection (see removeInspectedHolder). A holder
// that cannot be inspected, or a pruning failure, is logged and never fails the
// move-aside.
export const MAX_INCOMPLETE_HOLDERS = 3;
// The key files init and restore write (validators, oracles, genesis roles).
const TESTNET_KEY_FILES = new Set([...VALIDATOR_NAMES, "oracle1", "oracle2", "oracle3", "founder", "faucet", "liquidity", "ecosystem"].map((name) => `${name}.json`));
// Files a validator store writes into its data directory, and the temporary
// or quarantined copies of them it can leave behind after a crash.
const VALIDATOR_DATA_FILES = new Set([
  "blocks.ndjson", "metadata.json", "recovery-checkpoint.json", "history-retention.json", "node-identity.json",
  "peer-reputation.json", "native-peer-reputation.json", "signing-journal.ndjson",
  "state-v2.backend.json", "state-v2.keys.backend.json", "state-v2.nodes.ndjson", "state-v2.keys.ndjson", "state-v2.root.json",
  // Every store database runs in journal_mode = DELETE (storage.ts,
  // state-v2-node-store.ts), which leaves a -journal sidecar, never -wal/-shm.
  ...["state-v2.nodes.sqlite", "node-writer.lock.sqlite", "signing-journal.lock.sqlite"].flatMap((file) => [file, `${file}-journal`])
]);
// Exactly the names ConsensusStateStore.heightFile/blockFile/proposalFile/
// timeoutFile produce: canonical decimal, height a positive safe integer,
// round 0..99999999.
const CONSENSUS_STATE_FILE_PATTERN = /^H-([1-9]\d{0,15})(?:\.json|-B-[0-9a-f]{64}\.json|-r-(?:0|[1-9]\d{0,7})\.(?:proposal|timeout)\.json)$/;
function isConsensusStateFileName(name) {
  const match = CONSENSUS_STATE_FILE_PATTERN.exec(name);
  return Boolean(match) && BigInt(match[1]) <= BigInt(Number.MAX_SAFE_INTEGER);
}
// The leftover names each writer can leave behind, per file: quarantined
// State-v2 files (storage.ts quarantineCorruptStateV2), and the temporary files
// of the atomic writers (storage.ts, state-v2-store.ts, peer and p2p reputation,
// consensus-state-store.ts, peer-identity.ts). A suffix on any other file is
// not one the testnet writes.
// Numeric fields are canonical decimal as the writers interpolate them: a pid
// is a positive integer of at most 10 digits, a millisecond time at most 16.
const PID = "[1-9]\\d{0,9}";
const MS = "(?:0|[1-9]\\d{0,15})";
const CORRUPT_SUFFIX = new RegExp(`^\\.corrupt-${MS}-[0-9a-f]{12}$`);
const TMP_PID_HEX16_SUFFIX = new RegExp(`^\\.tmp-${PID}-[0-9a-f]{16}$`);
const TMP_PID_HEX12_SUFFIX = new RegExp(`^\\.tmp-${PID}-[0-9a-f]{12}$`);
const PID_TMP_SUFFIX = new RegExp(`^\\.${PID}\\.tmp$`);
const PID_MS_TMP_SUFFIX = new RegExp(`^\\.${PID}\\.${MS}\\.tmp$`);
const COMPACT_SUFFIX = new RegExp(`^\\.compact-${PID}-[0-9a-f]{16}$`);
// storage.ts pruneFinalizedHistory: `${blocksPath}.prune-${pid}-<16 hex>`, left
// behind if a finalized-history prune is interrupted (R24-1048-I1-F1).
const PRUNE_PID_HEX16_SUFFIX = new RegExp(`^\\.prune-${PID}-[0-9a-f]{16}$`);
const VALIDATOR_DATA_LEFTOVERS = new Map([
  ...["state-v2.nodes.ndjson", "state-v2.nodes.sqlite", "state-v2.nodes.sqlite-journal", "state-v2.keys.ndjson"].map((file) => [file, [CORRUPT_SUFFIX]]),
  ...["state-v2.backend.json", "state-v2.keys.backend.json", "state-v2.root.json"].map((file) => [file, [CORRUPT_SUFFIX, PID_MS_TMP_SUFFIX]]),
  ...["history-retention.json", "recovery-checkpoint.json", "peer-reputation.json", "native-peer-reputation.json"].map((file) => [file, [TMP_PID_HEX16_SUFFIX]]),
  ["metadata.json", [PID_TMP_SUFFIX]],
  ["blocks.ndjson", [PRUNE_PID_HEX16_SUFFIX]],
  ["signing-journal.ndjson", [COMPACT_SUFFIX]]
]);
// peer-identity.ts writes its temporary only at the validator data-directory root.
const IDENTITY_TEMP_PATTERN = new RegExp(`^\\.node-identity\\.json\\.${PID}\\.[0-9a-f]{32}\\.tmp$`);
function isStoreFileName(name, known, leftovers = new Map()) {
  if (known(name)) return true;
  for (let cut = name.indexOf("."); cut > 0; cut = name.indexOf(".", cut + 1)) {
    const base = name.slice(0, cut);
    if (!known(base)) continue;
    const patterns = typeof leftovers === "function" ? leftovers(base) : leftovers.get(base);
    if (patterns?.some((pattern) => pattern.test(name.slice(cut)))) return true;
  }
  return false;
}
async function onlyRegularFiles(path, known, leftovers) {
  for (const entry of await readdir(path)) {
    if (!isStoreFileName(entry, known, leftovers)) return false;
    if (!(await lstat(join(path, entry))).isFile()) return false;
  }
  return true;
}
async function isValidatorDataDir(path) {
  for (const entry of await readdir(path)) {
    const child = join(path, entry);
    const info = await lstat(child);
    if (entry === "consensus-state") {
      if (!info.isDirectory() || !(await onlyRegularFiles(child, isConsensusStateFileName, () => [TMP_PID_HEX12_SUFFIX]))) return false;
    } else if (!info.isFile() || !(IDENTITY_TEMP_PATTERN.test(entry) || isStoreFileName(entry, (name) => VALIDATOR_DATA_FILES.has(name), VALIDATOR_DATA_LEFTOVERS))) return false;
  }
  return true;
}
// Mount points from /proc/self/mountinfo (field 5, octal escapes decoded).
export function parseMountInfoMountPoints(text) {
  const points = [];
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 5) continue;
    points.push(fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8))));
  }
  return points;
}
// On Linux a mount table that cannot be read fails the inspection (the holder
// is then logged and kept); a same-device bind mount is visible nowhere else.
// Other platforms have no mountinfo and rely on the device check.
export async function readMountPointsFromProc(path = "/proc/self/mountinfo") {
  if (process.platform !== "linux") return [];
  return parseMountInfoMountPoints(await readFile(path, "utf8"));
}
// A holder with a mount point at or inside it (even a bind mount of the same
// filesystem), or with a directory on another device, is never pruned: a
// recursive removal would reach into the mounted storage.
async function holderHasMountPoint(holder, readMountPoints) {
  const real = await realpath(holder);
  for (const point of await readMountPoints()) {
    if (point === real || point.startsWith(`${real}/`)) return true;
  }
  const device = (await lstat(holder)).dev;
  const walk = async (path) => {
    for (const entry of await readdir(path)) {
      const info = await lstat(join(path, entry));
      if (info.dev !== device) return true;
      if (info.isDirectory() && await walk(join(path, entry))) return true;
    }
    return false;
  };
  return walk(holder);
}
async function isPrunableHolder(holder, name, readMountPoints = readMountPointsFromProc) {
  if (!(await isPrunableHolderLayout(holder, name))) return false;
  return !(await holderHasMountPoint(holder, readMountPoints));
}
async function isPrunableHolderLayout(holder, name) {
  const info = await lstat(holder);
  if (!info.isDirectory()) return false;
  const top = await readdir(holder);
  if (top.length !== 1 || top[0] !== name) return false;
  return isTestnetCreatedNetworkDir(join(holder, name));
}
// A network directory holding only what the open testnet creates (the layout a
// prunable holder has inside it).
async function isTestnetCreatedNetworkDir(inner) {
  if (!(await lstat(inner)).isDirectory()) return false;
  const entries = await readdir(inner);
  if (entries.some((entry) => !NETWORK_DIR_ENTRIES.has(entry))) return false;
  for (const entry of entries) {
    const child = join(inner, entry);
    const info = await lstat(child);
    if (entry === "keys") { if (!info.isDirectory() || !(await onlyRegularFiles(child, (name) => TESTNET_KEY_FILES.has(name)))) return false; }
    else if (entry.startsWith("data-")) { if (!info.isDirectory() || !(await isValidatorDataDir(child))) return false; }
    else if (!info.isFile()) return false;
  }
  return true;
}
// Only fields this writer produces: canonical decimal, a millisecond time of
// at most 16 digits, a pid of at most 10, a counter of at most 20. Other names
// are not holders (never pruned, never counted, never used for ordering).
const HOLDER_SUFFIX_PATTERN = /^\.incomplete-(0|[1-9]\d{0,15})-([1-9]\d{0,9})(?:-([1-9]\d{0,19}))?$/;
// Order key of a holder name: [time, counter, pid].
function holderOrder(name, entry) {
  if (!entry.startsWith(`${name}.incomplete-`)) return null;
  const match = HOLDER_SUFFIX_PATTERN.exec(entry.slice(name.length));
  return match ? [BigInt(match[1]), BigInt(match[3] ?? "0"), BigInt(match[2])] : null;
}
async function nextHolderOrder(dir, now) {
  const name = basename(dir);
  let newest = null;
  // Without the existing names the order cannot be kept, so a failure here
  // fails the move-aside (nothing has been moved yet).
  const entries = await readdir(resolve(dir, ".."));
  for (const entry of entries) {
    const order = holderOrder(name, entry);
    if (order && (!newest || compareHolderOrder(order, newest) > 0)) newest = order;
  }
  if (!newest || BigInt(now) > newest[0]) return { ms: BigInt(now), next: 0n };
  return { ms: newest[0], next: newest[1] + 1n };
}
// The largest fields a holder name may carry (see HOLDER_SUFFIX_PATTERN).
const MAX_HOLDER_COUNTER = 10n ** 20n - 1n;
const MAX_HOLDER_MS = 10n ** 16n - 1n;
// Holder names from (ms, counter) on, in order: past the largest counter the
// time advances by one millisecond, so every name stays one that is counted.
function* holderNames(dir, ms, counter) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (counter > MAX_HOLDER_COUNTER) { ms += 1n; counter = 0n; }
    if (ms > MAX_HOLDER_MS) return;
    const base = `${dir}.incomplete-${ms}-${process.pid}`;
    yield counter === 0n ? base : `${base}-${counter}`;
    counter += 1n;
  }
}
function compareHolderOrder(a, b) {
  for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}
// Everything that identifies a holder's contents: each path with its type,
// inode, size and modification time. A holder is removed only if this is
// unchanged since it was inspected.
async function holderFingerprint(path) {
  const lines = [];
  const walk = async (current, relative) => {
    const info = await lstat(current);
    lines.push(`${relative}\0${info.isDirectory() ? "d" : info.isFile() ? "f" : "o"}\0${info.dev}:${info.ino}\0${info.size}\0${info.mtimeMs}`);
    if (info.isDirectory()) for (const entry of (await readdir(current)).sort()) await walk(join(current, entry), `${relative}/${entry}`);
  };
  await walk(path, ".");
  return lines.join("\n");
}
// Remove only the holder that was inspected: it is first renamed to a private
// name (so the path can no longer be swapped under the removal), then checked
// again there; if it is not the same prunable holder, or the removal fails, it
// is renamed back and kept.
async function removeInspectedHolder(path, name, fingerprint, removeHolder, readMountPoints) {
  const trash = join(resolve(path, ".."), privatePruningName(basename(path), name));
  await rename(path, trash);
  let unchanged = false;
  try { unchanged = (await isPrunableHolder(trash, name, readMountPoints)) && (await holderFingerprint(trash)) === fingerprint; } catch { unchanged = false; }
  let failure;
  if (!unchanged) failure = new Error("it changed after it was inspected, so it is kept");
  else {
    try { await removeHolder(trash); return; } catch (error) { failure = error; }
  }
  // rename only lands on a missing path or an empty directory (a placeholder),
  // never on one with contents, so this cannot replace anything.
  try {
    await rename(trash, path);
  } catch (error) {
    throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; it could not be renamed back and is kept at ${trash} (${error instanceof Error ? error.message : String(error)})`);
  }
  throw failure;
}
// The private name is .<holder>.pruning-<pid>-<hex>. When that would not fit
// in a 255-byte name component (a long --dir basename), the short form
// .pruning-<pid>-<hex>.incomplete-<fields> is used: at most 92 bytes, and the
// holder name is <name>.incomplete-<fields> again.
const MAX_NAME_BYTES = 255;
function privatePruningName(holderName, name) {
  const tag = `pruning-${process.pid}-${randomBytes(6).toString("hex")}`;
  const long = `.${holderName}.${tag}`;
  if (Buffer.byteLength(long) <= MAX_NAME_BYTES) return long;
  return `.${tag}${holderName.slice(name.length)}`;
}
const STRANDED_PRUNING_PATTERN = new RegExp(`^\\.(.+)\\.pruning-(${PID})-[0-9a-f]{12}$`);
const SHORT_STRANDED_PRUNING_PATTERN = new RegExp(`^\\.pruning-(${PID})-[0-9a-f]{12}(\\.incomplete-.+)$`);
// The holder name and pid a private pruning name belongs to, or null.
async function strandedPruningOwner(parent, entry, name) {
  let match = STRANDED_PRUNING_PATTERN.exec(entry);
  if (match && entry.startsWith(`.${name}.incomplete-`) && holderOrder(name, match[1])) return { original: match[1], pid: Number(match[2]) };
  match = SHORT_STRANDED_PRUNING_PATTERN.exec(entry);
  if (!match || !holderOrder(name, `${name}${match[2]}`)) return null;
  // The short form does not carry the network name: it is this network's only
  // if it is empty (a removal got that far) or holds a directory of that name.
  const top = await readdir(join(parent, entry));
  if (top.length && !top.includes(name)) return null;
  return { original: `${name}${match[2]}`, pid: Number(match[1]) };
}
function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
// A crash between the private rename and the end of the removal leaves a
// holder under .<holder>.pruning-<pid>-<hex>. On the next start such a holder
// is finished off if it is still prunable (or empty), and otherwise renamed back
// under its own name, where it is kept like any other holder. A name of
// another live process is left alone (it may be pruning right now).
// `isProcessAlive` is a seam for tests only (a fixed fixture pid can be a live
// process on a CI host); production always uses processIsAlive.
async function recoverStrandedPruning(parent, name, { removeHolder, readMountPoints, isProcessAlive = processIsAlive, log }) {
  let entries;
  try { entries = await readdir(parent); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(`.${name}.incomplete-`) && !entry.startsWith(".pruning-")) continue;
    const path = join(parent, entry);
    try {
      if (!(await lstat(path)).isDirectory()) continue;
      const owner = await strandedPruningOwner(parent, entry, name);
      if (!owner || (owner.pid !== process.pid && isProcessAlive(owner.pid))) continue;
      const original = join(parent, owner.original);
      if ((await readdir(path)).length === 0) { await rmdir(path); log(`removed the empty moved-aside holder ${path} left by an interrupted pruning`); continue; }
      if (await isPrunableHolder(path, name, readMountPoints)) { await removeHolder(path); log(`pruned the moved-aside holder ${path} left by an interrupted pruning`); continue; }
      await rename(path, original);
      log(`renamed the moved-aside holder ${path} left by an interrupted pruning back to ${original}`);
    } catch (error) { log(`could not recover the moved-aside holder ${path} left by an interrupted pruning: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
export async function pruneIncompleteHolders(dir, { keep = MAX_INCOMPLETE_HOLDERS, exclude, removeHolder = (path) => rm(path, { recursive: true }), afterInspect = async () => {}, readMountPoints = readMountPointsFromProc, isProcessAlive = processIsAlive, log = (line) => console.error(line) } = {}) {
  const parent = resolve(dir, "..");
  const name = basename(dir);
  const candidates = [];
  await recoverStrandedPruning(parent, name, { removeHolder, readMountPoints, isProcessAlive, log });
  let entries;
  try { entries = await readdir(parent); } catch (error) { log(`could not prune moved-aside holders next to ${dir}: ${error instanceof Error ? error.message : String(error)}`); return []; }
  for (const entry of entries) {
    const order = holderOrder(name, entry);
    if (!order) continue;
    const path = join(parent, entry);
    const excluded = exclude !== undefined && resolve(path) === resolve(exclude);
    let fingerprint;
    if (excluded) {
      // The holder just created is never pruned, and it counts toward the bound
      // only if it is one pruning could remove (R24-1048-I1-F1); a failed
      // inspection counts it, as before.
      let counts = true;
      try { counts = await isPrunableHolder(path, name, readMountPoints); } catch { counts = true; }
      if (!counts) continue;
    } else {
      try {
        if (!(await isPrunableHolder(path, name, readMountPoints))) continue;
        fingerprint = await holderFingerprint(path);
      } catch (error) { log(`could not inspect the moved-aside holder ${path}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    }
    candidates.push({ path, excluded, order, fingerprint });
  }
  const compare = (a, b) => compareHolderOrder(a.order, b.order);
  const older = candidates.filter((holder) => !holder.excluded).sort(compare);
  const room = Math.max(0, keep - (candidates.length - older.length));
  const removed = [];
  for (const holder of older.slice(0, Math.max(0, older.length - room))) {
    try { await afterInspect(holder.path); await removeInspectedHolder(holder.path, name, holder.fingerprint, removeHolder, readMountPoints); removed.push(holder.path); log(`pruned the old moved-aside holder ${holder.path}`); }
    catch (error) { log(`could not prune the moved-aside holder ${holder.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return removed;
}
const V6_ACTIVATION_HEIGHT = 101;
const ATOMS_PER_ZYN = 100_000_000;
const FAUCET_DRIP_ATOMS = 100 * ATOMS_PER_ZYN;
// Red Team M2 option A: the validators inherit ZYRON_MEMPOOL_MIN_FEE_ATOMS
// from this process, so the faucet (and the smoke transfer) pay that floor.
// The open-testnet genesis has no fee policy. A bad value fails closed here.
const NODE_TRANSFER_FEE_ATOMS = nodeTransferFeeAtoms(undefined, parseMempoolMinFeeAtoms(process.env[MEMPOOL_MIN_FEE_ENV], MEMPOOL_MIN_FEE_ENV));
const DAY_MS = 86_400_000;
const ADDRESS_PATTERN = /^ZYN[0-9a-f]{40}$/;
const MAX_BODY_BYTES = 8 * 1024;
const NOTICE = "TESTNET — tokens have no value. ZyronChain open testnet: test ZYN cannot be bought or sold, is not redeemable for mainnet ZYN, and the network may be reset at any time. Not audited.";
const SNAPSHOT_MAGIC = "ZYRON-OPEN-TESTNET-STATE-V1";
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const RESERVED_CHAIN_IDS = new Set(["zyron-mainnet-1", "zyron-public-testnet-1"]);

// Validators-phase liveness: once the validator processes start, /health
// answers 200 "starting" while they make start-up progress (replay can take
// longer than any fixed timer on a small instance), 503 after
// ZYRON_STARTUP_STALL_MS without progress, and 503 past ZYRON_STARTUP_MAX_MS
// from that point even while progressing. /readyz is always strict.
export const STARTUP_STALL_MS = 5 * 60_000;
export const STARTUP_MAX_MS = 90 * 60_000;
export function parseStartupLimits(env = process.env) {
  const read = (value, fallback) => (/^[1-9][0-9]*$/.test(String(value ?? "")) && Number.isSafeInteger(Number(value)) ? Number(value) : fallback);
  return { stallMs: read(env.ZYRON_STARTUP_STALL_MS, STARTUP_STALL_MS), maxMs: read(env.ZYRON_STARTUP_MAX_MS, STARTUP_MAX_MS) };
}
// observe(fingerprint) records progress whenever the fingerprint changes
// (validator heights and reachability, data-directory sizes and mtimes,
// validator CPU time). liveness() maps the quorum result to the /health answer.
export function createStartupProgress({ stallMs = STARTUP_STALL_MS, maxMs = STARTUP_MAX_MS, now = Date.now, startedAtMs = now() } = {}) {
  let last; let lastProgressAtMs = startedAtMs;
  return {
    observe(fingerprint) { if (fingerprint !== last) { last = fingerprint; lastProgressAtMs = now(); } },
    liveness({ ok, everReady, path }) {
      const t = now();
      const elapsedMs = t - startedAtMs; const sinceProgressMs = t - lastProgressAtMs;
      const stalled = sinceProgressMs > stallMs; const capped = elapsedMs > maxMs;
      const starting = !ok && !everReady && !stalled && !capped;
      const status = ok ? "ready" : starting ? "starting" : "degraded";
      const code = ok || (starting && path !== "/readyz") ? 200 : 503;
      return { code, status, starting, progress: { elapsedMs, sinceProgressMs, stallMs, maxMs, stalled, capped } };
    }
  };
}
// Boot liveness (download/decrypt/replay/init): /health stays 200 only while
// start-up makes progress (a phase change, a download attempt, a replayed
// block, a validator copy, a block produced or committed by a fresh init). Longer than one 180 s download attempt; no wall-clock cap,
// because a large snapshot on a slow instance replays for a long time.
export const BOOT_STALL_MS = 5 * 60_000;
// A host outage (5xx, a network error, a body cut off mid-transfer) is retried
// for 172 s in total before the restore counts as failed, about as long as a
// missing asset: a failed restore creates a fresh TEST genesis, so a short
// outage of the asset host must not reset the network.
export const SNAPSHOT_DOWNLOAD_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 45_000, 60_000];
// A keeper replaces the published snapshot release asset in more than one step
// (`gh release upload --clobber` deletes the old asset and then uploads the new
// one; the scheduled keeper renames), so a cold start can see 404 while a
// snapshot does exist. A 404 is retried on its own schedule (160 s in total,
// enough for the upload of a snapshot far larger than today's) before it is
// taken to mean that nothing is published (which creates a fresh TEST genesis).
// Each wait is far below the 5-minute start-up stall limit.
export const SNAPSHOT_NOT_FOUND_RETRY_DELAYS_MS = [3_000, 7_000, 15_000, 30_000, 45_000, 60_000];
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
// POST /faucet spends a per-IP daily quota, so only the project's own pages may
// call it cross-origin: zyronchain.com and the explorer page this gateway
// serves itself (https://zyron-open-testnet.onrender.com). Other origins get no
// Access-Control-Allow-Origin, so a browser blocks the call. Override with a
// comma-separated ZYRON_FAUCET_ALLOWED_ORIGINS. Read-only routes keep "*".
export const DEFAULT_FAUCET_ALLOWED_ORIGINS = Object.freeze(["https://zyronchain.com", "https://zyron-open-testnet.onrender.com"]);
// Canonical form of an http(s) origin: lowercase scheme and host, default
// port dropped (https://x:443 and http://x:80 equal https://x and http://x).
// Returns null for anything that is not a bare origin (path, query, userinfo,
// other schemes, the opaque "null" origin).
export function normalizeFaucetOrigin(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (!/^https?:\/\/[^/?#@]+$/i.test(raw)) return null;
  return url.origin;
}
export function parseFaucetAllowedOrigins(value) {
  if (typeof value !== "string" || value.trim() === "") return new Set(DEFAULT_FAUCET_ALLOWED_ORIGINS);
  const origins = new Set();
  for (const entry of value.split(",")) {
    const raw = entry.trim();
    if (raw === "") continue;
    const origin = normalizeFaucetOrigin(raw);
    if (origin === null) throw new Error(`ZYRON_FAUCET_ALLOWED_ORIGINS: ${raw} is not an origin`);
    origins.add(origin);
  }
  if (origins.size === 0) throw new Error("ZYRON_FAUCET_ALLOWED_ORIGINS lists no origin");
  return origins;
}
// CORS headers for /faucet (responses and preflight). Always Vary: Origin;
// ACAO only for an allowed origin (compared port-normalized), echoed exactly
// as the browser sent it.
export function faucetCorsHeaders(origin, allowed) {
  const headers = { vary: "Origin" };
  if (faucetOriginAllowed(origin, allowed)) {
    Object.assign(headers, { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
  }
  return headers;
}
// Only allowlisted origins pass. There is deliberately no "Origin matches the
// Host header" exception: an attacker controlling DNS for evil.example can
// rebind it to this gateway, so a page on http://evil.example would send
// Host: evil.example and Origin: http://evil.example and look same-origin.
// The gateway's own explorer page is covered by the default allowlist; local
// and smoke gateways add theirs with ZYRON_FAUCET_ALLOWED_ORIGINS.
export function faucetOriginAllowed(origin, allowed) {
  const normalized = normalizeFaucetOrigin(origin);
  return normalized !== null && allowed.has(normalized);
}
// writeJson merges CORS first; a faucet response replaces it with these.
function withoutCors(extra) { return { "access-control-allow-origin": undefined, "access-control-allow-methods": undefined, "access-control-allow-headers": undefined, "access-control-max-age": undefined, ...extra }; }
export const FAUCET_UNAVAILABLE_MESSAGE = "faucet temporarily unavailable, retry later";
// POST /faucet. Rate limits run before the body is read. Errors are generic;
// the details (node error text included) go to the server log only.
export function createFaucetRoute({ origins, limits, faucetAddress, readJsonBody, send, log = (line) => console.error(line), durabilityView = async () => ({}) }) {
  return async (request, response, ip) => {
    const cors = withoutCors(faucetCorsHeaders(request.headers.origin, origins));
    const reply = (code, body, extra = {}) => writeJson(response, code, body, { ...cors, ...extra });
    const limited = (r) => reply(429, { error: "rate limit exceeded" }, { "retry-after": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) });
    // Origin and Content-Type are checked BEFORE any quota is taken, so a
    // cross-site no-cors POST (text/plain, form, Origin: null) cannot burn a
    // visitor's per-IP quota. A request with no Origin header (curl, scripts,
    // server-side clients) is served on purpose: browsers always send Origin on
    // a cross-origin POST, so a missing Origin is not a browser attack vector.
    // Only allowlisted origins pass; an Origin matching the Host header is
    // NOT trusted (DNS rebinding can forge that), see faucetOriginAllowed.
    const origin = request.headers.origin;
    if (origin !== undefined && !faucetOriginAllowed(origin, origins)) return reply(403, { error: "origin not allowed" });
    const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") return reply(415, { error: "content-type must be application/json" });
    try {
      const ipRate = limits.faucetIp.take(ip);
      if (!ipRate.allowed) return limited(ipRate);
      const body = await readJsonBody(request);
      const address = body && typeof body === "object" ? body.address : undefined;
      if (typeof address !== "string" || !ADDRESS_PATTERN.test(address) || address === faucetAddress) return reply(400, { error: "body must be {\"address\":\"ZYN...\"}" });
      const addressRate = limits.faucetAddress.take(address);
      if (!addressRate.allowed) return limited(addressRate);
      const globalRate = limits.faucetGlobal.take("global");
      if (!globalRate.allowed) return limited(globalRate);
      const result = await send(address);
      // The transfer is already queued: a failed durability lookup must not turn it into an error.
      const durability = await durabilityView().catch(() => ({}));
      return reply(200, { ...result, network: "testnet", valueBearing: false, note: "TESTNET — tokens have no value. Arrives in a coming block (about 30 seconds).", ...durability });
    } catch (error) {
      // Only the gateway's own fixed request-validation messages are passed through.
      const code = error?.statusCode;
      const own = (code === 400 || code === 413 || code === 415) && FAUCET_REQUEST_ERRORS.has(error?.message);
      if (!own) log(`faucet error: ${error instanceof Error ? error.message : String(error)}`);
      return reply(own ? code : 503, { error: own ? error.message : FAUCET_UNAVAILABLE_MESSAGE });
    }
  };
}
const FAUCET_REQUEST_ERRORS = new Set(["content-type must be application/json", "request body too large", "invalid JSON"]);
const SECURITY = { "x-content-type-options": "nosniff", "x-zyron-network": "testnet-no-value", "referrer-policy": "no-referrer" };
function writeJson(response, code, body, extra = {}) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  const headers = { ...CORS, ...SECURITY, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload), ...extra };
  for (const name of Object.keys(headers)) if (headers[name] === undefined) delete headers[name];
  response.writeHead(code, headers);
  response.end(payload);
}

// ---- gateway server: bound first, request handler swapped in when ready -------
// One HTTP server for the whole process lifetime. `run` binds it before the
// snapshot restore so a platform port scan sees the port immediately; the
// boot handler answers until runNetwork installs the full RPC handler.
export function createGatewayServer(handler) {
  let current = handler;
  const server = createServer({ headersTimeout: 5_000, requestTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16_384 }, (request, response) => current(request, response));
  server.maxConnections = 256;
  server.setHandler = (next) => { current = next; };
  return server;
}
export async function listenGateway(server, port, host) {
  await new Promise((done, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => { server.off("error", onError); done(); });
  });
  return server.address().port;
}
// Startup progress shared by the boot handler and the phase timing log.
export function createBootState(log = true) {
  const startedAtMs = Date.now();
  const boot = { phase: "boot", startedAtMs, phaseStartedAtMs: startedAtMs, lastProgressAtMs: startedAtMs, timings: {} };
  boot.progress = () => { boot.lastProgressAtMs = Date.now(); };
  boot.enter = (phase) => {
    const now = Date.now();
    boot.lastProgressAtMs = now;
    const ms = now - boot.phaseStartedAtMs;
    boot.timings[boot.phase] = (boot.timings[boot.phase] ?? 0) + ms;
    if (log) console.log(`startup phase ${boot.phase} done in ${ms}ms; entering ${phase} (elapsed ${now - startedAtMs}ms)`);
    boot.phase = phase; boot.phaseStartedAtMs = now;
  };
  return boot;
}
export function createBootHandler(boot, { stallMs = BOOT_STALL_MS } = {}) {
  return (request, response) => {
    if (request.method === "OPTIONS") { response.writeHead(204, CORS); return response.end(); }
    const path = String(request.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
    const now = Date.now();
    const sinceProgressMs = now - boot.lastProgressAtMs;
    const stalled = sinceProgressMs > stallMs;
    const body = { ok: false, status: stalled ? "stalled" : "starting", phase: boot.phase, network: "testnet", valueBearing: false, startedAtMs: boot.startedAtMs, elapsedMs: now - boot.startedAtMs, sinceProgressMs };
    // Liveness: the process is up and start-up is making progress, so the
    // platform health check passes. A stalled start-up answers 503 so the host
    // restarts it. Readiness and every RPC endpoint wait for the validators.
    if (request.method === "GET" && (path === "/health" || path === "/healthz") && !stalled) return writeJson(response, 200, body);
    return writeJson(response, 503, { ...body, error: stalled ? "gateway start-up stalled" : "gateway is starting; retry shortly" }, { "retry-after": "10" });
  };
}

const [command, ...rest] = process.argv.slice(2);
function option(name, fallback) {
  const index = rest.indexOf(name);
  if (index === -1) return fallback;
  assert.ok(rest[index + 1], `${name} needs a value`);
  return rest[index + 1];
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Downloads the published snapshot for a cold start. Transient download
// failures and a transient 404 are retried; the caller treats a final 404 as
// "nothing published" (fresh TEST genesis) and anything other than 200 as a
// failed restore. Returns the last response (a 200 body is left unread). With
// `readBody`, a 200 body is read inside the retry loop (a body cut off
// mid-transfer is downloaded again) and `{ status: 200, bytes }` is returned.
export async function downloadSnapshot(url, { fetchImpl = fetch, sleepImpl = sleep, onAttempt = () => {}, log = console.error, notFoundDelaysMs = SNAPSHOT_NOT_FOUND_RETRY_DELAYS_MS, failureDelaysMs = SNAPSHOT_DOWNLOAD_RETRY_DELAYS_MS, readBody = false } = {}) {
  let failures = 0;
  let notFound = 0;
  for (;;) {
    try {
      onAttempt();
      const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (response.status === 200) return readBody ? { status: 200, bytes: Buffer.from(await response.arrayBuffer()) } : response;
      if (response.status === 404) {
        if (notFound >= notFoundDelaysMs.length) return response;
        await response.arrayBuffer().catch(() => undefined);
        log("snapshot download returned 404; retrying in case the published snapshot is being replaced");
        await sleepImpl(notFoundDelaysMs[notFound]);
        notFound += 1;
        continue;
      }
      if (failures >= failureDelaysMs.length) return response;
      await response.arrayBuffer().catch(() => undefined);
      log(`snapshot download returned ${response.status}; retrying`);
    } catch (error) {
      if (failures >= failureDelaysMs.length) throw error;
      log(`snapshot download failed (${error instanceof Error ? error.message : String(error)}); retrying`);
    }
    await sleepImpl(failureDelaysMs[failures]);
    failures += 1;
  }
}

function assertTestnetChainId(chainId) {
  assert.ok(/^[a-z0-9-]{3,64}$/.test(chainId) && chainId.includes("testnet"), "chain ID must contain 'testnet'");
  assert.ok(!RESERVED_CHAIN_IDS.has(chainId) && !chainId.includes("mainnet"), "chain ID is reserved");
}
function newAccount() {
  const privateKey = generatePrivateKey();
  const publicKey = publicKeyFromPrivate(privateKey);
  return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
}
async function writeSecret(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}
async function readSecret(path) {
  const info = await stat(path);
  assert.equal(info.mode & 0o077, 0, `${path} must not be readable by group/other`);
  return JSON.parse(await readFile(path, "utf8"));
}

// ---- durable watermark (follower forks after a cold start) ------------------
// The hosted instance has no persistent disk: a cold start restores the last
// snapshot the keeper published, which can be minutes behind the tip that was
// already finalized and served. The validators then finalize those heights a
// second time with different blocks, and every follower that synced the lost
// blocks is stuck on a fork. The validators cannot know what they finalized
// before the disk was lost, so the gateway never serves a block to followers
// (the /peer surface) above the durable height: the height of the newest
// published snapshot that matches this chain. Anything a follower syncs is
// therefore inside every snapshot a later cold start can restore.
export function createDurableWatermark({ height = 0, tipHash, fetchPublished, localHashAt, log = () => {} }) {
  const state = { height, tipHash, checkedAtMs: undefined, lastError: undefined };
  let pending;
  async function check() {
    const published = await fetchPublished();
    if (!published) return state;
    const { height: publishedHeight, tipHash: publishedHash } = published;
    if (!Number.isSafeInteger(publishedHeight) || publishedHeight <= state.height) { state.checkedAtMs = Date.now(); return state; }
    const local = await localHashAt(publishedHeight);
    if (local !== publishedHash) throw new Error(`published snapshot block ${publishedHeight} (${String(publishedHash).slice(0, 12)}) is not on this chain (${String(local).slice(0, 12)})`);
    state.height = publishedHeight; state.tipHash = publishedHash; state.checkedAtMs = Date.now(); state.lastError = undefined;
    return state;
  }
  return {
    get height() { return state.height; },
    get tipHash() { return state.tipHash; },
    status() { return { durableHeight: state.height, durableCheckedAtMs: state.checkedAtMs ?? null, ...(state.lastError ? { durableError: state.lastError } : {}) }; },
    refresh() {
      pending ??= check().catch((error) => { state.lastError = error instanceof Error ? error.message : String(error); log(`durable watermark: ${state.lastError}`); return state; }).finally(() => { pending = undefined; });
      return pending;
    }
  };
}

// Reads the published snapshot and returns its height and tip hash, or
// undefined when none is published yet.
export async function readPublishedSnapshotTip(url, secret, { fetchImpl = fetch, timeoutMs = 60_000, cache } = {}) {
  // A HEAD first: an unchanged asset (same ETag or Last-Modified and length)
  // is not downloaded again.
  let validator;
  if (cache) {
    const head = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
    if (head?.status === 404) return undefined;
    if (head?.status === 200) {
      const tag = head.headers.get("etag") ?? head.headers.get("last-modified");
      validator = tag ? `${tag}|${head.headers.get("content-length") ?? ""}` : undefined;
      if (validator && cache.validator === validator) return cache.tip;
    }
  }
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return undefined; }
  if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw new Error(`published snapshot returned ${response.status}`); }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_SNAPSHOT_BYTES) { await response.body?.cancel().catch(() => {}); throw new Error("published snapshot is larger than the snapshot size limit"); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) { size += chunk.length; if (size > MAX_SNAPSHOT_BYTES) throw new Error("published snapshot is larger than the snapshot size limit"); chunks.push(chunk); }
  const bundle = openSnapshot(Buffer.concat(chunks), secret);
  const blocks = bundle?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  const tip = { height: blocks.length, tipHash: blocks[blocks.length - 1].hash };
  if (cache) { cache.validator = validator; cache.tip = tip; }
  return tip;
}

// Caps a follower status at the durable watermark.
export function capPeerStatus(status, watermark) {
  if (!watermark || status.height <= watermark.height) return status;
  return { ...status, height: watermark.height, tipHash: watermark.tipHash };
}

// ---- sealed state snapshots (TEST keys + public blocks) ---------------------------
function snapshotKey(secret) {
  assert.ok(typeof secret === "string" && secret.length >= 32, "ZYRON_TESTNET_STATE_SECRET must be at least 32 characters");
  return createHash("sha256").update(`zyron-open-testnet-state\0${secret}`).digest();
}
export function sealSnapshot(bundle, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", snapshotKey(secret), iv);
  cipher.setAAD(Buffer.from(SNAPSHOT_MAGIC));
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(bundle)))), cipher.final()]);
  return Buffer.concat([Buffer.from(`${SNAPSHOT_MAGIC}\n`), iv, cipher.getAuthTag(), body]);
}
export function openSnapshot(bytes, secret) {
  const header = Buffer.from(`${SNAPSHOT_MAGIC}\n`);
  assert.ok(bytes.length > header.length + 28 && bytes.length <= MAX_SNAPSHOT_BYTES, "snapshot size out of range");
  assert.ok(bytes.subarray(0, header.length).equals(header), "not an open-testnet state snapshot");
  const iv = bytes.subarray(header.length, header.length + 12);
  const tag = bytes.subarray(header.length + 12, header.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", snapshotKey(secret), iv);
  decipher.setAAD(Buffer.from(SNAPSHOT_MAGIC));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(bytes.subarray(header.length + 28)), decipher.final()]);
  return JSON.parse(gunzipSync(plain, { maxOutputLength: MAX_SNAPSHOT_BYTES * 4 }).toString("utf8"));
}
// Rebuilds a network directory from a snapshot bundle. Every block is replayed
// once through ChainStore validation (into data-v1); keys must match the genesis
// validator set. A recovery checkpoint of that validated state is written and
// the finalized log + checkpoint are copied to the other validators, each of
// which re-opens and verifies them, so neither the restore nor the validator
// start-up pays for a full replay four times (startup cost on a 0.1-CPU host).
// R21-1046-L1: with a checkpoint, ChainStore.open only line-scans the records
// below it, so every validator's files are compared byte-for-byte (SHA-256)
// with the replayed ones before they are opened, and all of them again right
// before network.json is written.
// R26-1048-L1: every copy step reports progress (each copied file, each stored
// block record a copy's ChainStore.open reads, each hashed chunk), so the boot
// liveness check can tell a long restore from a stall. Progress events are
// labelled ({ step, validator, file }); the boot handler only needs the tick.
const RESTORED_DATA_FILES = ["metadata.json", "blocks.ndjson", "recovery-checkpoint.json"];
async function fileSha256(path, onChunk = () => {}) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) { hash.update(chunk); onChunk(); }
  return hash.digest("hex");
}
// R31-1060-L2: copy in chunks with a tick per chunk, so a large log is not one
// silent step. The destination is new (exclusive create) and owner-only. A
// write may complete fewer bytes than asked (Codex P2 on #1060), so each chunk
// is written until it is complete. openFile is a test seam.
export async function copyFileWithProgress(source, destination, onChunk = () => {}, { openFile = open } = {}) {
  const handle = await openFile(destination, "wx", 0o600);
  try {
    for await (const chunk of createReadStream(source)) {
      for (let offset = 0; offset < chunk.length;) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!(bytesWritten > 0)) throw new Error(`restore copy of ${source} made no progress`);
        offset += bytesWritten;
      }
      onChunk();
    }
  } finally {
    await handle.close();
  }
}
export async function restoreNetwork(dir, bundle, expectedChainId, { onProgress = () => {} } = {}) {
  assert.equal(bundle?.format, SNAPSHOT_MAGIC, "unknown snapshot format");
  const { genesis, network, keys, blocks } = bundle;
  assertTestnetChainId(genesis.chainId);
  if (expectedChainId) assert.equal(genesis.chainId, expectedChainId, "snapshot is for another chain ID");
  assert.equal(network.chainId, genesis.chainId);
  assert.equal(new ZyronChain(genesis).genesisHash, network.genesisHash, "snapshot genesis hash mismatch");
  for (const [index, name] of VALIDATOR_NAMES.entries()) assert.equal(publicKeyFromPrivate(keys[name]), genesis.validators[index].publicKey, `snapshot key ${name} does not match genesis`);
  for (const [index, name] of ["oracle1", "oracle2", "oracle3"].entries()) {
    assert.equal(publicKeyFromPrivate(keys[name]), genesis.activityOracles[index], `snapshot oracle key ${name} does not match genesis`);
  }
  assert.equal(addressFromPublicKey(publicKeyFromPrivate(keys.faucet)), network.faucetAddress, "snapshot faucet key mismatch");
  assert.equal(genesis.publicDistributionRelease?.address, network.faucetAddress, "snapshot public-distribution release does not match the faucet");
  assert.ok(Array.isArray(blocks) && blocks.length >= V6_ACTIVATION_HEIGHT - 1, "snapshot has too few blocks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await mkdir(join(dir, "keys"), { mode: 0o700 });
  for (const [name, privateKey] of Object.entries(keys)) {
    assert.ok(/^[a-z0-9]{1,16}$/.test(name), "invalid key name");
    await writeSecret(join(dir, "keys", `${name}.json`), { privateKey });
  }
  await writeFile(join(dir, "genesis.json"), `${JSON.stringify(genesis, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  const [first, ...others] = VALIDATOR_NAMES;
  const firstData = join(dir, `data-${first}`);
  await mkdir(firstData, { mode: 0o700 });
  const store = await ChainStore.open(genesis, firstData);
  for (const block of blocks) { await store.commitFinalizedBlock(block); onProgress({ step: "replay-block" }); }
  assert.equal(store.chain.height, blocks.length, "snapshot replay height mismatch");
  const checkpoint = await store.writeRecoveryCheckpoint();
  onProgress({ step: "checkpoint" });
  const replayed = new Map();
  for (const file of RESTORED_DATA_FILES) replayed.set(file, await fileSha256(join(firstData, file), () => onProgress({ step: "hash-chunk", validator: first, file })));
  onProgress({ step: "digested" });
  const verifyFiles = async (name, data) => {
    for (const file of RESTORED_DATA_FILES) {
      const digest = await fileSha256(join(data, file), () => onProgress({ step: "verify-chunk", validator: name, file }));
      if (digest !== replayed.get(file)) throw new Error(`restored ${name} ${file} does not match the replayed log`);
    }
  };
  for (const name of others) {
    const data = join(dir, `data-${name}`);
    await mkdir(data, { mode: 0o700 });
    for (const file of RESTORED_DATA_FILES) {
      await copyFileWithProgress(join(firstData, file), join(data, file), () => onProgress({ step: "copy-chunk", validator: name, file }));
      onProgress({ step: "copy-file", validator: name, file });
    }
    await chmod(join(data, "blocks.ndjson"), 0o600);
    await verifyFiles(name, data);
    const copy = await ChainStore.open(genesis, data, {
      onBlockRecord: () => onProgress({ step: "open-record", validator: name }),
      onStateV2Batch: () => onProgress({ step: "open-state", validator: name }),
      onCheckpointStep: () => onProgress({ step: "open-checkpoint", validator: name })
    });
    assert.ok(copy.chain.height === blocks.length && copy.chain.tip.hash === checkpoint.tipHash, `restored ${name} state does not match the replayed state`);
    onProgress({ step: "copy-opened", validator: name });
  }
  // R28-1059-L1: every copy (not only the replayed one) is checked again
  // right before the completion marker.
  for (const name of VALIDATOR_NAMES) await verifyFiles(name, join(dir, `data-${name}`));
  await writeNetworkMarker(dir, network);
  // The replayed chain (in memory) and its blocks are the start of the
  // gateway's verified snapshot history, so a cold start does not validate
  // the restored history a second time before the first snapshot.
  const verifiedHistory = { chain: store.chain, blocks };
  return { chainId: genesis.chainId, genesisHash: network.genesisHash, height: blocks.length, tipHash: checkpoint.tipHash, verifiedHistory };
}

// R37-1072-L1: a local filesystem error while the verified snapshot is written
// to this instance's disk (EIO, EMFILE, ENOSPC, ...; a Node system error, also
// when wrapped as an error's cause) says nothing about the snapshot. The
// partial directory is moved aside and the restore runs again from the same
// downloaded bundle; if the disk keeps failing (or the partial directory
// cannot be moved aside) the error is marked localIo, and
// start-up stops instead of creating a fresh TEST genesis (the host restarts
// the instance, which downloads and restores the published snapshot again).
// Errors about the snapshot itself (format, chain ID, genesis, keys, replay)
// are not retried. Each wait stays far below the start-up stall limit.
export const LOCAL_RESTORE_RETRY_DELAYS_MS = [2_000, 5_000];
// The State-v2 database is built on this instance's disk during the replay
// (it is never part of the bundle), so better-sqlite3 storage failures there
// are local as well. A SqliteError carries a string SQLite result code but no
// syscall; only the storage/resource codes below (and their extended codes,
// e.g. SQLITE_IOERR_WRITE) count. SQL, constraint and misuse errors do not.
const LOCAL_SQLITE_ERROR_CODES = ["SQLITE_IOERR", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_NOMEM", "SQLITE_READONLY", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_PROTOCOL", "SQLITE_CORRUPT", "SQLITE_NOTADB"];
function isLocalSqliteError(error) {
  if (error.name !== "SqliteError" || typeof error.code !== "string") return false;
  return LOCAL_SQLITE_ERROR_CODES.some((code) => error.code === code || error.code.startsWith(`${code}_`));
}
export function isLocalIoError(error) {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 8; current = current.cause, depth += 1) {
    if (typeof current.code === "string" && typeof current.syscall === "string") return true;
    if (isLocalSqliteError(current)) return true;
  }
  return false;
}
export async function restoreNetworkWithLocalRetry(dir, bundle, expectedChainId, { onProgress = () => {}, restore = restoreNetwork, moveAside = moveAsideIncompleteNetworkDir, sleepImpl = sleep, log = (line) => console.error(line), delays = LOCAL_RESTORE_RETRY_DELAYS_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await restore(dir, bundle, expectedChainId, { onProgress });
    } catch (error) {
      if (!isLocalIoError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= delays.length) {
        throw Object.assign(new Error(`local I/O error during the restore after ${attempt + 1} attempts: ${message}`), { localIo: true, cause: error });
      }
      log(`restore hit a local I/O error (${message}); restoring the downloaded snapshot again in ${delays[attempt]} ms (attempt ${attempt + 2} of ${delays.length + 1})`);
      // The partial directory must be moved aside (never deleted) before the
      // next attempt. If that fails too, the disk is still failing: stop as a
      // local I/O error rather than fall through to a fresh TEST genesis.
      let aside;
      try { aside = await moveAside(dir); } catch (moveError) {
        const moveMessage = moveError instanceof Error ? moveError.message : String(moveError);
        throw Object.assign(new Error(`local I/O error during the restore (${message}); the partial directory could not be moved aside: ${moveMessage}`), { localIo: true, cause: error });
      }
      if (aside) log(`moved the partial restore directory to ${aside}`);
      onProgress({ step: "local-io-retry" });
      await sleepImpl(delays[attempt]);
      onProgress({ step: "local-io-retry" });
    }
  }
}

// ---- init: fresh TEST keys, fixed-supply-v1 genesis, v6 prefix ----------------
export async function initNetwork(dir, chainId, { onProgress = () => {} } = {}) {
  assertTestnetChainId(chainId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const keyDir = join(dir, "keys");
  await mkdir(keyDir, { mode: 0o700 });
  const validators = VALIDATOR_NAMES.map(() => newAccount());
  const oracleNames = ["oracle1", "oracle2", "oracle3"];
  const oracles = oracleNames.map(() => newAccount());
  const roles = { founder: newAccount(), faucet: newAccount(), liquidity: newAccount(), ecosystem: newAccount() };
  const plan = fixedSupplyPlanAtoms();
  const genesis = {
    chainId,
    // Backdated so the 365-day public-distribution line has vested the 100 ZYN faucet drip.
    timestampMs: Date.now() - 10 * 60_000,
    validators: validators.map(({ publicKey, address }) => ({ address, publicKey })),
    activityOracles: oracles.map((oracle) => oracle.publicKey),
    activityOracleThreshold: 2,
    activityOraclePolicy: "threshold-v1",
    activityPool: roles.ecosystem.address,
    allocations: [
      { address: roles.founder.address, amountAtoms: plan.founder },
      { address: roles.faucet.address, amountAtoms: plan.publicDistribution },
      { address: roles.liquidity.address, amountAtoms: plan.liquidityReserve },
      { address: roles.ecosystem.address, amountAtoms: plan.ecosystemReserve }
    ],
    allocationLocks: { founderVesting: roles.founder.address, permanentLiquidity: roles.liquidity.address },
    publicDistributionRelease: defaultPublicDistributionRelease(roles.faucet.address),
    launchProfile: FIXED_SUPPLY_LAUNCH_PROFILE
  };
  const chain = new ZyronChain(genesis);
  for (const [index, name] of VALIDATOR_NAMES.entries()) await writeSecret(join(keyDir, `${name}.json`), { privateKey: validators[index].privateKey });
  for (const [index, name] of oracleNames.entries()) await writeSecret(join(keyDir, `${name}.json`), { privateKey: oracles[index].privateKey });
  for (const [name, account] of Object.entries(roles)) await writeSecret(join(keyDir, `${name}.json`), { privateKey: account.privateKey });

  // MIN_PROTOCOL_UPDATE_DELAY is 100 blocks: heights 1-100 are produced offline
  // (block 1 carries the unanimous upgrade to v6 at height 101) so every block
  // the live validators finalize is a v6 block with a commit certificate.
  const byPublicKey = new Map(validators.map((v) => [v.publicKey, v.privateKey]));
  const proposal = { chainId, nonce: 1, sender: validators[0].address, activationHeight: V6_ACTIVATION_HEIGHT, protocolVersion: 6 };
  const upgrade = createProtocolUpgrade({
    ...proposal,
    approvals: validators.map((v) => createProtocolUpgradeApproval(proposal, v.privateKey, v.publicKey)),
    timestampMs: genesis.timestampMs + 1
  }, validators[0].privateKey, validators[0].publicKey);
  const blocks = [];
  for (let height = 1; height < V6_ACTIVATION_HEIGHT; height += 1) {
    const timestampMs = genesis.timestampMs + height * 10;
    const proposer = expectedValidator(genesis.validators, height, 0);
    let block = chain.produceBlock(height === 1 ? [upgrade] : [], byPublicKey.get(proposer.publicKey), { timestampMs });
    for (const key of byPublicKey.values()) block = chain.attestBlock(block, key);
    chain.acceptBlock(block, timestampMs);
    blocks.push(block);
    onProgress();
  }
  assert.equal(chain.protocolVersionAt(V6_ACTIVATION_HEIGHT), 6);
  await writeFile(join(dir, "genesis.json"), `${JSON.stringify(genesis, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  for (const name of VALIDATOR_NAMES) {
    const data = join(dir, `data-${name}`);
    await mkdir(data, { mode: 0o700 });
    const store = await ChainStore.open(genesis, data);
    for (const block of blocks) { await store.commitFinalizedBlock(block); onProgress(); }
  }
  const publicInfo = {
    network: "testnet", valueBearing: false, notice: NOTICE, chainId, genesisHash: chain.genesisHash,
    launchProfile: FIXED_SUPPLY_LAUNCH_PROFILE, activityOraclePolicy: "threshold-v1", activityOracleThreshold: 2,
    activityOracleCount: oracles.length, protocolV6ActivationHeight: V6_ACTIVATION_HEIGHT,
    validators: genesis.validators, faucetAddress: roles.faucet.address,
    roles: { founderVesting: roles.founder.address, publicDistributionFaucet: roles.faucet.address, permanentLiquidity: roles.liquidity.address, ecosystemActivityPool: roles.ecosystem.address }
  };
  await writeNetworkMarker(dir, publicInfo);
  return publicInfo;
}

// ---- snapshot history verification (R21-1046-L1, option C) -------------------
// Validators serve historical blocks from their own block log. Below a recovery
// checkpoint that log is not re-validated on open, so a block corrupted on one
// validator's disk could be sealed into the published snapshot, fail the next
// cold-start replay and reset the testnet. Before sealing, every block must
// pass the finalized-block validation a cold-start replay applies
// (ZyronChain.acceptBlock: envelope, proposer and attestation signatures,
// finality certificate, transactions, state root) on top of the blocks before
// it, and the history must end at the live tip. Byte agreement between
// validators is not used: honest validators can hold different valid
// certificates for one block, and identical bytes can still be invalid
// (R28-1059-M1/M2). If no validator serves a valid block at some height,
// nothing is sealed and the last published snapshot stays in place.
export function verifySnapshotBlocks(blocks, { tip, tipHash, chainId, genesisHash }) {
  assert.ok(Array.isArray(blocks) && blocks.length === tip, `snapshot history has ${Array.isArray(blocks) ? blocks.length : "no"} blocks, expected ${tip}`);
  let previous = genesisHash;
  for (const [index, block] of blocks.entries()) {
    const height = index + 1;
    const header = block?.header;
    assert.ok(header && typeof header === "object" && header.height === height && header.chainId === chainId, `snapshot block ${height} has the wrong height or chain ID`);
    assert.equal(header.previousHash, previous, `snapshot block ${height} does not link to block ${height - 1}`);
    assert.equal(blockHash(header), block.hash, `snapshot block ${height} hash does not match its header`);
    assert.ok(Array.isArray(block.transactions) && merkleRoot(block.transactions) === header.transactionRoot, `snapshot block ${height} transactions do not match its header`);
    assert.equal(new Set(block.transactions.map((tx) => tx?.txid)).size, block.transactions.length, `snapshot block ${height} repeats a transaction`);
    previous = block.hash;
  }
  assert.equal(previous, tipHash, "snapshot history does not end at the live tip");
}

// Verified snapshot history: the in-memory chain after the verified blocks.
// The gateway keeps one and extends it on each build, so full validation is
// paid once per block (validation is replay-priced on a 0.1-CPU host).
export function createSnapshotHistory(genesis) {
  return { chain: new ZyronChain(genesis), blocks: [] };
}
const yieldToEventLoop = () => new Promise((done) => setImmediate(done));

// readers: [{ name, read(from, limit) -> blocks }], one per validator, tried
// in order for each height. A candidate block is used only if it passes full
// finalized-block validation on top of the verified history; a reader that
// fails, serves nothing or serves an invalid block is reported (once per
// build) through onReject and the next reader is tried for that height.
export async function collectSnapshotBlocks(readers, { tip, tipHash, chainId, genesisHash, genesis, history, pageSize = 100, onReject = () => {} } = {}) {
  const expected = { tip, tipHash, chainId, genesisHash };
  assert.ok(Number.isSafeInteger(tip) && tip >= 1, "snapshot tip must be a positive height");
  const verified = history ?? createSnapshotHistory(genesis);
  assert.equal(verified.chain.genesisHash, genesisHash, "snapshot history is for another genesis");
  assert.equal(verified.chain.height, verified.blocks.length, "snapshot history is inconsistent");
  const reported = new Set();
  const reject = (index, error) => {
    const { name } = readers[index];
    if (reported.has(name)) return;
    reported.add(name);
    onReject(name, error);
  };
  const pages = readers.map(() => ({ from: 0, blocks: [], failed: false }));
  async function blockFrom(index, height) {
    const page = pages[index];
    if (page.failed) return undefined;
    if (height < page.from || height >= page.from + page.blocks.length) {
      let served;
      try {
        served = await readers[index].read(height, Math.min(pageSize, tip - height + 1));
      } catch (error) {
        page.failed = true;
        reject(index, error);
        return undefined;
      }
      page.from = height; page.blocks = [];
      if (Array.isArray(served)) {
        for (const block of served) {
          if (block?.header?.height !== page.from + page.blocks.length) break;
          page.blocks.push(block);
        }
      }
      if (page.blocks.length === 0) {
        page.failed = true;
        reject(index, new Error(`block ${height} not served`));
        return undefined;
      }
    }
    return page.blocks[height - page.from];
  }
  while (verified.blocks.length < tip) {
    const height = verified.blocks.length + 1;
    const failures = new Map();
    let accepted;
    for (let index = 0; index < readers.length && !accepted; index += 1) {
      const block = await blockFrom(index, height);
      if (!block) continue;
      let line;
      try {
        // Served blocks are parsed JSON and can hold values canonicalJson
        // refuses (unsafe numbers, excessive nesting): reject that validator.
        line = canonicalJson(block);
      } catch (error) {
        reject(index, new Error(`block ${height} is not canonical (${error instanceof Error ? error.message : String(error)})`));
        continue;
      }
      if (failures.has(line)) { reject(index, failures.get(line)); continue; }
      try {
        const candidate = structuredClone(block);
        // acceptBlock validates completely before it changes the chain, so a
        // rejected candidate leaves the verified history untouched.
        verified.chain.acceptBlock(structuredClone(candidate), Date.now());
        accepted = candidate;
      } catch (error) {
        const failure = new Error(`block ${height} failed validation (${error instanceof Error ? error.message : String(error)})`);
        failures.set(line, failure);
        reject(index, failure);
      }
    }
    if (!accepted) throw new Error(`snapshot history: no validator served a block ${height} that passes finalized-block validation`);
    verified.blocks.push(accepted);
    await yieldToEventLoop();
  }
  const blocks = verified.blocks.slice(0, tip);
  verifySnapshotBlocks(blocks, expected);
  return blocks;
}

// ---- run: validators + gateway ---------------------------------------------------
export async function runNetwork(dir, { gatewayPort, basePort = 9300, host = "127.0.0.1", log = true, stateSecret, persistence = { mode: "local-disk" }, server, verifiedHistory, durable, startupLimits = parseStartupLimits() } = {}) {
  const runStartedAtMs = Date.now();
  const genesisPath = join(dir, "genesis.json");
  const genesis = JSON.parse(await readFile(genesisPath, "utf8"));
  assertTestnetChainId(genesis.chainId);
  const info = JSON.parse(await readFile(join(dir, "network.json"), "utf8"));
  const faucetKey = (await readSecret(join(dir, "keys", "faucet.json"))).privateKey;
  const faucet = { privateKey: faucetKey, publicKey: publicKeyFromPrivate(faucetKey) };
  faucet.address = addressFromPublicKey(faucet.publicKey);
  assert.equal(faucet.address, info.faucetAddress);
  const chainId = genesis.chainId;
  const ports = VALIDATOR_NAMES.map((_, i) => basePort + i);
  // Hosted validator public keys, matched against the active validator set
  // each validator reports (GET /validator-set) for the gateway quorum.
  const validatorPublicKeys = new Map();
  for (const name of VALIDATOR_NAMES) validatorPublicKeys.set(name, publicKeyFromPrivate((await readSecret(join(dir, "keys", `${name}.json`))).privateKey));
  const nodes = new Map();
  let shuttingDown = false;
  // Consensus relay (docs/CONSENSUS_RELAY.md): allowlisted external peers,
  // reached by the hosted validators through a loopback-only mailbox.
  const relayPeers = parseRelayPeers(process.env.ZYRON_RELAY_PEERS);
  let relay; let mailbox; let mailboxPort;
  if (relayPeers.size > 0) {
    // Active validator set from the gateway's verified history (validator
    // updates are scheduled at least 100 blocks ahead, so the history knows
    // an activation before it happens).
    // The history is extended from the live chain every few seconds while the
    // relay is on (refreshHistory below), not only by snapshot builds.
    const votingPeer = (address) => relayVotingPeer(snapshotHistory.chain, address);
    relay = new ConsensusRelay({ chainId, genesisHash: info.genesisHash, peers: relayPeers, hostedCount: VALIDATOR_NAMES.length, isVotingPeer: votingPeer,
      async forwardToHosted(index, path, body) {
        const node = nodes.get(VALIDATOR_NAMES[index]);
        if (!node || node.exit) return { status: 503, body: Buffer.from('{"error":"validator not running"}') };
        const response = await fetch(`http://127.0.0.1:${node.port}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-zyron-rpc-version": "1" }, body, signal: AbortSignal.timeout(8_000) });
        return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
      } });
    mailboxPort = basePort + 50;
    mailbox = createServer({ headersTimeout: 5_000, requestTimeout: 10_000 }, async (request, response) => {
      try {
        const match = /^\/x\/(ZYN[0-9a-f]{40})(\/[a-z0-9/]+)(?:\?([a-z0-9=&]{0,64}))?$/.exec(request.url ?? "");
        if ((request.method !== "POST" && request.method !== "GET") || !match) { const notFound = Buffer.from('{"error":"Not found"}'); response.writeHead(404, relayReplyHeaders(notFound.length)); return response.end(notFound); }
        const body = request.method === "POST" ? await readRawBody(request, RELAY_MAX_CONSENSUS_REQUEST_BYTES) : Buffer.alloc(0);
        const result = await relay.mailbox(match[1], match[2], body, request.method, match[3] ?? "");
        response.writeHead(result.status, relayReplyHeaders(result.body.length));
        response.end(result.body);
      } catch (error) {
        const code = error?.statusCode ?? 500;
        const failure = Buffer.from(JSON.stringify({ error: code === 500 ? "internal error" : error.message })); response.writeHead(code, relayReplyHeaders(failure.length)); response.end(failure);
      }
    });
    await new Promise((done, fail) => { mailbox.once("error", fail); mailbox.listen(mailboxPort, "127.0.0.1", () => { mailbox.off("error", fail); done(); }); });
    console.log(`consensus relay: ${relayPeers.size} external peer(s); mailbox on 127.0.0.1:${mailboxPort}`);
  }

  function startValidator(name) {
    const index = VALIDATOR_NAMES.indexOf(name);
    const args = [dist("cli.js"), "node", "--genesis", genesisPath, "--data", join(dir, `data-${name}`),
      "--host", "127.0.0.1", "--port", String(ports[index]), "--validator-key", join(dir, "keys", `${name}.json`),
      // P1-02-M3: the validators are reachable only over loopback, by this
      // gateway (which enforces the public per-client limits) and by each
      // other. Without the exemption every public request and all peer traffic
      // shared one node RPC quota for 127.0.0.1.
      "--rpc-rate-limit-exempt", "127.0.0.1"];
    for (const [i, port] of ports.entries()) if (i !== index) args.push("--peer", `http://127.0.0.1:${port}`);
    if (relay) for (const address of relay.addresses()) args.push("--peer", `http://127.0.0.1:${mailboxPort}/x/${address}`);
    const child = spawn(process.execPath, args, { cwd: l1Root, stdio: ["ignore", "pipe", "pipe"] });
    const prefix = `[${name}] `;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      if (log) process.stdout.write(chunk.toString("utf8").split("\n").filter(Boolean).map((l) => prefix + l).join("\n") + "\n");
    });
    const node = { name, child, port: ports[index], startedAt: Date.now() };
    node.closed = new Promise((done) => child.once("exit", (code, signal) => { node.exit = { code, signal }; done(); }));
    child.once("exit", () => {
      if (shuttingDown || node.stopping) return;
      // Supervisor: a crashed validator restarts from its durable data directory.
      console.error(`${name} exited (${JSON.stringify(node.exit)}); restarting in 5s`);
      setTimeout(() => { if (!shuttingDown) startValidator(name); }, 5_000);
    });
    nodes.set(name, node);
    return node;
  }
  async function stopValidator(name) {
    const node = nodes.get(name);
    if (!node || node.exit) return;
    node.stopping = true;
    node.child.kill("SIGTERM");
    const timer = setTimeout(() => node.child.kill("SIGKILL"), 10_000);
    await node.closed;
    clearTimeout(timer);
  }

  async function readRawBody(request, max) {
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw Object.assign(new Error("content-type must be application/json"), { statusCode: 415 });
    if (Number(request.headers["content-length"] ?? 0) > max) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > max) throw Object.assign(new Error("request body too large"), { statusCode: 413 }); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function nodeFetch(port, path, init = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init, headers: { "x-zyron-rpc-version": "1", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8_000)
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = { error: "invalid node response" }; }
    return { status: response.status, body };
  }
  // Reads and submissions go to the first validator that answers, so one
  // validator restarting does not take the public RPC down.
  async function anyNode(path, init) {
    let last;
    for (const name of VALIDATOR_NAMES) {
      const node = nodes.get(name);
      if (!node || node.exit) continue;
      try { const result = await nodeFetch(node.port, path, init); if (result.status < 500) return result; last = result; } catch (error) { last = { status: 502, body: { error: "node unavailable" } }; }
    }
    return last ?? { status: 502, body: { error: "no validator available" } };
  }
  // P1-02-L1: GET /health is not rate limited (the platform health check uses
  // it), so the validator fan-out is cached for HEALTH_CACHE_MS and concurrent
  // requests share one in-flight check.
  const HEALTH_CACHE_MS = 2_000;
  let healthCache; let healthCacheAt = 0; let healthInFlight;
  function cachedValidatorStatuses() {
    if (healthCache && Date.now() - healthCacheAt < HEALTH_CACHE_MS) return Promise.resolve(healthCache);
    healthInFlight ??= validatorStatuses().then((validators) => {
      healthCache = { validators, checkedAtMs: Date.now() }; healthCacheAt = healthCache.checkedAtMs;
      return healthCache;
    }).finally(() => { healthInFlight = undefined; });
    return healthInFlight;
  }
  async function validatorStatuses() {
    return Promise.all(VALIDATOR_NAMES.map(async (name) => {
      const node = nodes.get(name);
      const publicKey = validatorPublicKeys.get(name);
      try {
        const [status, ready, set] = await Promise.all([
          nodeFetch(node.port, "/status"), nodeFetch(node.port, "/readyz"),
          nodeFetch(node.port, "/validator-set").catch(() => undefined)
        ]);
        // Reports are untrusted; createActiveSetTracker validates them.
        const activeSet = set?.status === 200 && set.body && typeof set.body === "object" ? set.body : undefined;
        return { name, publicKey, up: true, height: status.body.height, tipHash: status.body.tipHash, ready: ready.status === 200, ...(activeSet ? { activeSet } : {}) };
      } catch { return { name, publicKey, up: false }; }
    }));
  }
  let statusCache; let statusCacheAt = 0;
  async function chainStatus() {
    if (statusCache && Date.now() - statusCacheAt < 1_000) return statusCache;
    const [status, protocol] = await Promise.all([anyNode("/status"), anyNode("/protocol")]);
    if (status.status !== 200) throw new Error("node not ready");
    const nextProtocol = protocol.status === 200 ? protocol.body.nextVersion : 1;
    statusCache = {
      network: "testnet", valueBearing: false, notice: NOTICE, chainId, genesisHash: status.body.genesisHash,
      launchProfile: genesis.launchProfile, activityOraclePolicy: genesis.activityOraclePolicy,
      activityOracleThreshold: genesis.activityOracleThreshold, activityOracleCount: genesis.activityOracles.length,
      height: status.body.height, tipHash: status.body.tipHash,
      protocolVersion: nextProtocol, transactionVersion: nextProtocol >= 3 ? 2 : 1, blockIntervalSeconds: 30,
      validatorCount: genesis.validators.length, persistence,
      faucet: { address: faucet.address, dripZyn: FAUCET_DRIP_ATOMS / ATOMS_PER_ZYN, perAddressPerDay: 1 }
    };
    statusCacheAt = Date.now();
    return statusCache;
  }

  class WindowLimiter {
    constructor(limit, windowMs, maxKeys = 50_000) { Object.assign(this, { limit, windowMs, maxKeys, hits: new Map() }); }
    take(key, now = Date.now()) {
      let entry = this.hits.get(key);
      if (!entry || now - entry.start >= this.windowMs) {
        if (!entry && this.hits.size >= this.maxKeys) for (const [k, e] of this.hits) if (now - e.start >= this.windowMs) this.hits.delete(k);
        if (!entry && this.hits.size >= this.maxKeys) return { allowed: false, retryAfterMs: this.windowMs };
        entry = { start: now, count: 0 };
        this.hits.set(key, entry);
      }
      if (entry.count >= this.limit) return { allowed: false, retryAfterMs: entry.start + this.windowMs - now };
      entry.count += 1;
      return { allowed: true };
    }
  }
  const limits = {
    read: new WindowLimiter(Number(process.env.ZYRON_RPC_READS_PER_MINUTE ?? 240), 60_000),
    write: new WindowLimiter(Number(process.env.ZYRON_RPC_TX_PER_MINUTE ?? 10), 60_000),
    faucetIp: new WindowLimiter(5, DAY_MS),
    faucetAddress: new WindowLimiter(1, DAY_MS),
    faucetGlobal: new WindowLimiter(200, 3_600_000, 1),
    snapshot: new WindowLimiter(30, 3_600_000, 1),
    relayIp: new WindowLimiter(Number(process.env.ZYRON_RELAY_REQUESTS_PER_MINUTE_PER_IP ?? 1200), 60_000)
  };
  let snapshotCache; let snapshotCacheAt = 0; let snapshotBuild;
  // Verified history (R28-1059): from the restore replay when there was one,
  // otherwise validated from genesis on the first build.
  const snapshotHistory = verifiedHistory ?? createSnapshotHistory(genesis);
  // Durable watermark (see createDurableWatermark): only when the chain lives
  // in published snapshots. `durable.fetchPublished` reads the newest one.
  let watermark;
  if (durable) {
    const restoredBlocks = verifiedHistory?.blocks ?? [];
    watermark = createDurableWatermark({
      height: restoredBlocks.length, tipHash: restoredBlocks.length ? restoredBlocks[restoredBlocks.length - 1].hash : undefined,
      fetchPublished: durable.fetchPublished,
      localHashAt: async (height) => { const r = await anyNode(`/blocks?from=${height}&limit=1`); if (r.status !== 200 || !Array.isArray(r.body?.blocks) || !r.body.blocks[0]) throw new Error(`local block ${height} unavailable`); return r.body.blocks[0].hash; },
      log: (line) => console.error(line)
    });
    // The restored snapshot is already durable; the first check waits one
    // interval so a cold start does not download the snapshot twice.
    const timer = setInterval(() => { void watermark.refresh(); }, durable.intervalMs ?? 120_000); timer.unref();
  }
  // Trusted active set: seeded (read-only) from the verified history's set at
  // tip+1, or genesis when there is no verified history; it then moves only
  // when a quorum of it agrees on a new set of at least STRICT_MIN_VALIDATORS.
  const activeSetSeed = activeSetSeedFromHistory(verifiedHistory);
  const activeSetTracker = createActiveSetTracker(genesis.validators, { addressOf: (publicKey) => addressFromPublicKey(publicKey), minValidators: STRICT_MIN_VALIDATORS, ...(activeSetSeed ? { initial: activeSetSeed } : {}) });
  if (log) console.log(`active set seeded from ${activeSetTracker.seededFrom}${activeSetSeed ? ` (height ${activeSetSeed.height}, ${activeSetSeed.validators.length} validators)` : ""}`);
  // One build at a time: concurrent requests share it, and the verified
  // history is never extended twice in parallel.
  function buildSnapshot() {
    if (snapshotCache && Date.now() - snapshotCacheAt < 60_000) return Promise.resolve(snapshotCache);
    snapshotBuild ??= buildSnapshotNow().finally(() => { snapshotBuild = undefined; });
    return snapshotBuild;
  }
  // One writer at a time for the verified history (snapshot builds and the
  // relay's membership refresh both extend it).
  let historyLock = Promise.resolve();
  function extendHistory(readers, tip, tipHash) {
    const run = historyLock.then(() => collectSnapshotBlocks(readers, {
      tip, tipHash, chainId, genesisHash: info.genesisHash, history: snapshotHistory,
      onReject: (name, error) => console.error(`snapshot: history from ${name} not used (${error instanceof Error ? error.message : String(error)})`)
    }));
    historyLock = run.then(() => undefined, () => undefined);
    return run;
  }
  function historyReaders() {
    return VALIDATOR_NAMES.map((name) => ({
      name,
      async read(from, limit) {
        const node = nodes.get(name);
        if (!node || node.exit) throw new Error("validator not running");
        const result = await nodeFetch(node.port, `/blocks?from=${from}&limit=${limit}`);
        if (result.status !== 200 || !Array.isArray(result.body?.blocks)) throw new Error(`block read returned ${result.status}`);
        return result.body.blocks;
      }
    }));
  }
  let historyRefresh;
  function refreshHistory() {
    historyRefresh ??= (async () => {
      const { height: tip, tipHash } = await chainStatus();
      if (tip > snapshotHistory.chain.height) await extendHistory(historyReaders(), tip, tipHash);
    })().catch((error) => console.error(`relay: validator history refresh failed (${error instanceof Error ? error.message : String(error)})`)).finally(() => { historyRefresh = undefined; });
    return historyRefresh;
  }
  if (relay) { const timer = setInterval(() => { void refreshHistory(); }, 5_000); timer.unref(); }
  async function buildSnapshotNow() {
    const { height: tip, tipHash } = await chainStatus();
    const blocks = await extendHistory(historyReaders(), tip, tipHash);
    const keys = {};
    for (const name of [...VALIDATOR_NAMES, "oracle1", "oracle2", "oracle3", "founder", "faucet", "liquidity", "ecosystem"]) keys[name] = (await readSecret(join(dir, "keys", `${name}.json`))).privateKey;
    const sealed = sealSnapshot({ format: SNAPSHOT_MAGIC, createdAtMs: Date.now(), genesis, network: info, keys, blocks }, stateSecret);
    snapshotCache = { sealed, height: tip }; snapshotCacheAt = Date.now();
    return snapshotCache;
  }
  // Rate-limit identity (P1-02). ZYRON_TRUST_CF_CONNECTING_IP=1 (Render, whose
  // Cloudflare edge sets CF-Connecting-IP): that header. Otherwise, from a
  // loopback tunnel/proxy: the rightmost X-Forwarded-For entry, which that
  // proxy appended. The client-supplied leftmost entry is never used, and
  // anything malformed fails closed to the proxy's shared bucket. IPv6
  // clients share one bucket per /64.
  const trustCloudflareConnectingIp = process.env.ZYRON_TRUST_CF_CONNECTING_IP === "1";
  function clientIp(request) {
    return gatewayClientIdentity(request.socket.remoteAddress, request.headers, { trustCloudflareConnectingIp });
  }

  let faucetQueue = Promise.resolve(); let lastFaucetNonce = 0; let lastFaucetNonceAt = 0;
  function faucetSend(receiver) {
    const run = faucetQueue.then(async () => {
      const status = await chainStatus();
      const nonceResponse = await anyNode(`/nonce/${faucet.address}`);
      if (nonceResponse.status !== 200) throw new Error(`faucet nonce lookup failed (status ${nonceResponse.status})`);
      if (Date.now() - lastFaucetNonceAt > 180_000) lastFaucetNonce = 0;
      const nonce = Math.max(nonceResponse.body.nonce, lastFaucetNonce) + 1;
      const tx = createTransfer({ chainId, nonce, sender: faucet.address, receiver, amountAtoms: FAUCET_DRIP_ATOMS, feeAtoms: NODE_TRANSFER_FEE_ATOMS, timestampMs: Date.now() },
        faucet.privateKey, faucet.publicKey, status.transactionVersion);
      const submitted = await anyNode("/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
      // The node's error text is logged by the faucet route, never returned.
      if (submitted.status < 200 || submitted.status > 299) throw new Error(`faucet transfer rejected by node (status ${submitted.status}): ${String(submitted.body?.error ?? "").slice(0, 300)}`);
      lastFaucetNonce = nonce; lastFaucetNonceAt = Date.now();
      return { txid: tx.txid, receiver, amountAtoms: FAUCET_DRIP_ATOMS, nonce };
    });
    faucetQueue = run.catch(() => undefined);
    return run;
  }

  // Blocks above durableHeight are finalized but not yet in a published
  // snapshot: a cold start can replace them (docs/OPEN_TESTNET.md).
  function durability() { return watermark ? { peerCap: "durable", durableHeight: watermark.height } : { peerCap: "off" }; }
  const DURABILITY_NOTE = "finalized blocks above durableHeight can be replaced by a cold start";
  // State answers (balances, nonces, accepted txids) come from the live tip; mark
  // whether that tip is already covered by a published snapshot.
  function durableView(asOfHeight) {
    const d = durability();
    return { asOfHeight, ...d, ...(watermark ? { durable: asOfHeight <= watermark.height, durabilityNote: DURABILITY_NOTE } : {}) };
  }
  // POST /tx and POST /faucet answer before the transfer is in any block, so a
  // `durable` flag computed from the tip would say nothing about the transfer.
  // They report only the watermark; the caller waits for durableHeight to pass
  // the block that includes the transfer.
  function submitDurableView(asOfHeight) {
    const { durable: _tipOnly, ...view } = durableView(asOfHeight);
    return view;
  }
  const faucetOrigins = parseFaucetAllowedOrigins(process.env.ZYRON_FAUCET_ALLOWED_ORIGINS);
  console.log(`faucet: cross-origin calls allowed from ${[...faucetOrigins].join(", ")}`);
  const PEER_RPC = { "x-zyron-rpc-version": "1" };
  const sendJson = writeJson;
  const explorerHtml = await readFile(join(l1Root, "scripts", "open-testnet", "explorer.html"));
  function sendHtml(response) {
    response.writeHead(200, { ...SECURITY, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-length": explorerHtml.length,
      "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    response.end(explorerHtml);
  }
  const limited = (response, r) => sendJson(response, 429, { error: "rate limit exceeded" }, { "retry-after": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) });
  async function readJsonBody(request) {
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw Object.assign(new Error("content-type must be application/json"), { statusCode: 415 });
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 400 }); }
  }
  const faucetRoute = createFaucetRoute({ origins: faucetOrigins, limits, faucetAddress: faucet.address, readJsonBody, send: faucetSend, durabilityView: async () => submitDurableView((await chainStatus()).height) });
  // Explorer view of a block: summary fields only.
  function summarizeBlock(block) {
    return {
      height: block.header.height, hash: block.hash, previousHash: block.header.previousHash, timestampMs: block.header.timestampMs,
      version: block.header.version, round: block.header.round, commitRound: block.commitRound, proposer: block.header.proposer,
      attestations: Array.isArray(block.attestations) ? block.attestations.length : 0,
      transactions: (block.transactions ?? []).map((tx) => ({ txid: tx.txid, kind: tx.kind, sender: tx.sender, receiver: tx.receiver, amountAtoms: tx.amountAtoms, feeAtoms: tx.feeAtoms, nonce: tx.nonce }))
    };
  }

  let active = 0; let everReady = false;
  const startup = createStartupProgress({ ...startupLimits, startedAtMs: runStartedAtMs });
  // Cheap start-up progress signal: replay is silent in the node logs, so the
  // fingerprint also covers each validator data directory (top-level sizes and
  // mtimes) and each validator's CPU time (Linux /proc), besides heights.
  async function startupFingerprint(statuses) {
    const parts = await Promise.all(VALIDATOR_NAMES.map(async (name, i) => {
      const s = statuses[i] ?? {};
      let files = "";
      try {
        const base = join(dir, `data-${name}`);
        for (const entry of (await readdir(base)).sort()) { const st = await stat(join(base, entry)).catch(() => undefined); if (st) files += `${entry}:${st.size}:${st.mtimeMs};`; }
      } catch {}
      let cpu = "";
      const pid = nodes.get(name)?.child?.pid;
      if (pid) try { const f = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" "); cpu = `${pid}:${Math.floor((Number(f[11]) + Number(f[12])) / 100)}`; } catch {}
      return `${s.up ? 1 : 0}:${s.height ?? ""}:${cpu}|${files}`;
    }));
    return parts.join("#");
  }
  const handler = async (request, response) => {
    if (active >= 64) return sendJson(response, 503, { error: "busy, retry shortly" }, { "retry-after": "1" });
    active += 1; response.once("close", () => { active -= 1; });
    try {
      const rawUrl = request.url ?? "/";
      if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.length > 256 || /[\u0000-\u001f\u007f\\]/.test(rawUrl)) return sendJson(response, 400, { error: "invalid request target" });
      const url = new URL(rawUrl, "http://gateway.invalid");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (request.method === "OPTIONS") {
        if (path === "/faucet") { response.writeHead(204, faucetCorsHeaders(request.headers.origin, faucetOrigins)); return response.end(); }
        response.writeHead(204, CORS); return response.end();
      }
      const ip = clientIp(request);
      if (request.method === "GET") {
        if (path === "/health" || path === "/healthz" || path === "/readyz") {
          const { validators: statuses, checkedAtMs } = await cachedValidatorStatuses();
          const up = statuses.filter((v) => v.up);
          const heights = up.map((v) => v.height);
          // Quorum of the ACTIVE validator set (follows validator_update).
          const { ok, quorum, activeValidatorCount, activeValidatorsUp, activeSetHeight, activeSetSource, activeSetFallback, activeSetSeed: seed, activeSetRejected } = activeSetTracker.evaluate(statuses);
          const validators = statuses.map(({ activeSet: _activeSet, ...rest }) => rest);
          if (ok) everReady = true;
          // Until the validators first reach a quorum, liveness stays 200
          // "starting" while start-up progresses (bounded by the stall window
          // and the hard cap); afterwards a lost quorum is a 503. /readyz is
          // always strict.
          if (!ok && !everReady) startup.observe(await startupFingerprint(statuses));
          const { code, status, starting, progress } = startup.liveness({ ok, everReady, path });
          return sendJson(response, code, { ok, status, ...(starting ? { phase: "validators" } : {}), ...(!ok && !everReady ? { startup: progress } : {}), network: "testnet", valueBearing: false, chainId, persistence, peerCap: watermark ? "durable" : "off", ...(watermark ? watermark.status() : {}), quorum, activeValidatorCount, activeValidatorsUp, activeSetHeight, activeSetSource, activeSetFallback, activeSetSeed: seed, ...(activeSetRejected ? { activeSetRejected } : {}), validatorsUp: up.length, maxHeight: heights.length ? Math.max(...heights) : null, checkedAtMs, validators });
        }
        const rate = limits.read.take(ip);
        if (!rate.allowed) return limited(response, rate);
        // Read-only peer surface for volunteer follower nodes (`node --peer <gateway>/peer`):
        // raw /status and /blocks only. Validator P2P write paths are never exposed.
        if (path === "/peer/status") {
          const result = await anyNode("/status");
          if (result.status === 200 && watermark && !watermark.tipHash) return sendJson(response, 503, { error: "no durable block yet" }, PEER_RPC);
          return sendJson(response, result.status === 200 ? 200 : 502, result.status === 200 ? capPeerStatus(result.body, watermark) : { error: "node unavailable" }, PEER_RPC);
        }
        if (path === "/peer/blocks") {
          const from = Number.parseInt(url.searchParams.get("from") ?? "", 10);
          const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
          if (!Number.isSafeInteger(from) || from < 1) return sendJson(response, 400, { error: "from must be a positive integer" });
          if (watermark && from > watermark.height) return sendJson(response, 404, { error: "no durable block at that height yet" }, PEER_RPC);
          const capped = watermark ? Math.min(limit, watermark.height - from + 1) : limit;
          const result = await anyNode(`/blocks?from=${from}&limit=${capped}`);
          return sendJson(response, result.status === 200 ? 200 : 502, result.status === 200 ? { ...result.body, blocks: result.body.blocks.slice(0, capped) } : { error: "node unavailable" }, PEER_RPC);
        }
        if (path === "/state/snapshot" && stateSecret) {
          const snapshotRate = limits.snapshot.take("global");
          if (!snapshotRate.allowed) return limited(response, snapshotRate);
          const { sealed, height } = await buildSnapshot();
          response.writeHead(200, { ...SECURITY, "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": sealed.length, "x-zyron-snapshot-height": String(height), "x-zyron-genesis-hash": info.genesisHash });
          return response.end(sealed);
        }
        if (path === "/" || path === "/explorer") return sendHtml(response);
        if (path === "/api" ) return sendJson(response, 200, { name: "ZyronChain open TESTNET RPC", ...(await chainStatus()), endpoints: ["GET /health", "GET /status", "GET /network", "GET /genesis", "GET /account/{address}", "GET /balance/{address}", "GET /nonce/{address}", "GET /blocks?from=&limit=", "GET /block/{height}", "GET /peer/status", "GET /peer/blocks?from=&limit=", "POST /tx", "POST /faucet {address}"] });
        if (path === "/status" || path === "/chain") return sendJson(response, 200, { ...(await chainStatus()), ...durability() });
        if (path === "/network") return sendJson(response, 200, info);
        if (path === "/genesis") return sendJson(response, 200, { network: "testnet", valueBearing: false, genesisHash: info.genesisHash, genesis });
        if (path === "/blocks" || path.startsWith("/block/")) {
          const tip = (await chainStatus()).height;
          let from; let limit;
          if (path === "/blocks") {
            limit = Math.min(20, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "10", 10) || 10));
            const requested = url.searchParams.get("from");
            from = requested === null ? Math.max(1, tip - limit + 1) : Number.parseInt(requested, 10);
          } else { from = Number.parseInt(path.slice(7), 10); limit = 1; }
          if (!Number.isSafeInteger(from) || from < 1 || from > tip) return sendJson(response, 404, { error: "no such block" });
          const result = await anyNode(`/blocks?from=${from}&limit=${limit}`);
          if (result.status !== 200) return sendJson(response, 502, { error: "node unavailable" });
          const blocks = result.body.blocks.map((block) => ({ ...summarizeBlock(block), ...(watermark ? { durable: block.header.height <= watermark.height } : {}) }));
          return sendJson(response, 200, path === "/blocks" ? { network: "testnet", tip, blocks } : blocks[0]);
        }
        for (const prefix of ["/balance/", "/nonce/", "/account/"]) {
          if (!path.startsWith(prefix)) continue;
          const address = path.slice(prefix.length);
          if (!ADDRESS_PATTERN.test(address)) return sendJson(response, 400, { error: "invalid address" });
          const [balance, nonce] = await Promise.all([anyNode(`/balance/${address}`), anyNode(`/nonce/${address}`)]);
          if (balance.status !== 200 || nonce.status !== 200) return sendJson(response, 502, { error: "node unavailable" });
          const asOf = (await chainStatus()).height;
          const body = { network: "testnet", chainId, height: asOf, address, balanceAtoms: balance.body.balanceAtoms, nonce: nonce.body.nonce, ...durableView(asOf) };
          if (prefix === "/balance/") delete body.nonce;
          if (prefix === "/nonce/") delete body.balanceAtoms;
          return sendJson(response, 200, body);
        }
        return sendJson(response, 404, { error: "not found" });
      }
      if (request.method === "POST") {
        if (path === "/tx") {
          const rate = limits.write.take(ip);
          if (!rate.allowed) return limited(response, rate);
          const tx = await readJsonBody(request);
          if (!tx || typeof tx !== "object" || Array.isArray(tx)) return sendJson(response, 400, { error: "transaction must be an object" });
          if (tx.kind !== "transfer") return sendJson(response, 400, { error: "only transfer transactions are accepted by this gateway" });
          if (tx.chainId !== chainId) return sendJson(response, 400, { error: `wrong chainId; this testnet is ${chainId}` });
          const submitted = await anyNode("/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
          if (submitted.status < 200 || submitted.status > 299) return sendJson(response, 400, { error: String(submitted.body?.error ?? "rejected").slice(0, 300) });
          return sendJson(response, 200, { accepted: true, txid: submitted.body.txid, note: "Included in a coming block (about 30 seconds).", ...submitDurableView((await chainStatus()).height) });
        }
        if (path === "/faucet") return await faucetRoute(request, response, ip);
        if (relay && path.startsWith("/relay/v1/")) {
          const relayRate = limits.relayIp.take(ip);
          if (!relayRate.allowed) return limited(response, relayRate);
          const body = await readRawBody(request, RELAY_MAX_BODY_BYTES);
          const result = await relay.handlePublic(path.slice("/relay/v1/".length), request.headers, body, ip);
          return sendJson(response, result.status, result.body, { "cache-control": "no-store" });
        }
        return sendJson(response, 404, { error: "not found" });
      }
      return sendJson(response, 405, { error: "method not allowed" });
    } catch (error) {
      const code = error?.statusCode ?? 500;
      if (code === 500) console.error(`gateway error: ${error instanceof Error ? error.message : String(error)}`);
      return sendJson(response, code, { error: code === 500 ? "internal error" : error.message });
    }
  };

  for (const name of VALIDATOR_NAMES) startValidator(name);
  const gateway = server ?? createGatewayServer(handler);
  gateway.setHandler(handler);
  const port = gateway.listening ? gateway.address().port : await listenGateway(gateway, gatewayPort, host);
  console.log(`ZyronChain open TESTNET gateway on ${host}:${port}; chain ${chainId}; genesis ${info.genesisHash}; validators ${VALIDATOR_NAMES.length}; value-bearing=false`);
  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    await new Promise((done) => gateway.close(() => done()));
    if (mailbox) await new Promise((done) => mailbox.close(() => done()));
    await Promise.all(VALIDATOR_NAMES.map((name) => stopValidator(name)));
  }
  async function waitForQuorum(timeoutMs = startupLimits.maxMs) {
    const deadline = Date.now() + timeoutMs;
    while (!shuttingDown && Date.now() < deadline) {
      if (activeSetTracker.evaluate(await validatorStatuses()).ok) return true;
      await sleep(1_000);
    }
    return false;
  }
  return { port, chainId, info, faucet, shutdown, stopValidator, startValidator, validatorStatuses, waitForQuorum };
}

// ---- smoke: disposable end-to-end check --------------------------------------
async function smoke() {
  const dir = await mkdtemp(join(tmpdir(), "zyron-open-testnet-"));
  await chmod(dir, 0o700);
  let network;
  try {
    const info = await initNetwork(join(dir, "net"), "zyron-smoke-testnet-1");
    var smokeSecret = randomBytes(32).toString("base64");
    network = await runNetwork(join(dir, "net"), { gatewayPort: 0, basePort: 19300 + Math.floor(Math.random() * 500) * 4, log: false, stateSecret: smokeSecret });
    const base = `http://127.0.0.1:${network.port}`;
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() }; };
    const post = async (p, b) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
    async function until(label, check, timeoutMs = 240_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { const v = await check().catch(() => undefined); if (v) return v; await sleep(1_000); }
      throw new Error(`timed out waiting for ${label}`);
    }
    const allAt = async (min) => { const vs = await network.validatorStatuses(); return vs.every((v) => v.up && v.height >= min) && new Set(vs.map((v) => v.height)).size === 1 && new Set(vs.map((v) => v.tipHash)).size === 1 ? vs[0] : false; };
    await until("first v6 block on all validators", () => allAt(V6_ACTIVATION_HEIGHT));
    const status = (await get("/status")).body;
    assert.equal(status.protocolVersion, 6); assert.equal(status.valueBearing, false); assert.equal(status.launchProfile, "fixed-supply-v1");
    assert.equal(status.activityOraclePolicy, "threshold-v1"); assert.equal(status.activityOracleThreshold, 2); assert.equal(status.activityOracleCount, 3);
    const published = (await get("/genesis")).body.genesis;
    assert.equal(published.publicDistributionRelease.address, info.faucetAddress);
    assert.equal(published.publicDistributionRelease.cliffMs, 0);
    assert.equal(published.publicDistributionRelease.linearMs, 31_536_000_000);
    assert.match((await get("/")).body, /TESTNET/);
    const block = (await get(`/block/${V6_ACTIVATION_HEIGHT}`)).body;
    assert.equal(block.version, 6);
    assert.equal((await post("/block", {})).status, 404);
    const peerStatus = await fetch(`${base}/peer/status`);
    assert.equal(peerStatus.headers.get("x-zyron-rpc-version"), "1");
    assert.deepEqual(Object.keys(await peerStatus.json()).sort(), ["chainId", "genesisHash", "height", "tipHash"]);
    assert.equal((await (await fetch(`${base}/peer/blocks?from=1&limit=2`)).json()).blocks.length, 2);
    assert.equal((await post("/peer/block", {})).status, 404);
    // P1-02-M3 / L1: GET /health stays unthrottled for platform health checks,
    // so it is cached and must not exhaust the validators' node RPC capacity;
    // and public reads beyond 600/min in aggregate (several clients, each
    // within the gateway's per-client limit) must not starve the validators.
    const healthBurst = await Promise.all(Array.from({ length: 32 }, () => get("/health")));
    assert.ok(healthBurst.every((r) => r.status === 200 && Number.isSafeInteger(r.body.checkedAtMs)), "health burst");
    assert.ok(new Set(healthBurst.map((r) => r.body.checkedAtMs)).size <= 2, "concurrent /health requests must share one cached validator check");
    let healthFlood = 0;
    await Promise.all(Array.from({ length: 32 }, async () => { while (healthFlood < 800) { healthFlood += 1; await (await fetch(`${base}/health`)).arrayBuffer(); } }));
    const readAs = async (client) => (await fetch(`${base}/balance/${info.faucetAddress}`, { headers: { "x-forwarded-for": client } })).status;
    const readStatuses = {}; let readIndex = 0;
    await Promise.all(Array.from({ length: 32 }, async () => {
      while (readIndex < 800) { const client = `198.51.100.${10 + (readIndex % 4)}`; readIndex += 1; const code = await readAs(client); readStatuses[code] = (readStatuses[code] ?? 0) + 1; }
    }));
    assert.deepEqual(readStatuses, { 200: 800 }, "reads within each client's limit must not hit the validators' rate limit");
    assert.equal((await get(`/balance/${info.faucetAddress}`)).status, 200);
    assert.ok((await network.validatorStatuses()).every((v) => v.up && v.ready), "validators must stay ready under gateway load");
    const alice = newAccount(); const bob = newAccount();
    const drip = await post("/faucet", { address: alice.address });
    assert.equal(drip.status, 200, JSON.stringify(drip.body));
    assert.equal((await post("/faucet", { address: alice.address })).status, 429);
    await until("faucet drip", async () => (await get(`/account/${alice.address}`)).body.balanceAtoms === FAUCET_DRIP_ATOMS);
    const nonce = (await get(`/nonce/${alice.address}`)).body.nonce;
    const tx = createTransfer({ chainId: info.chainId, nonce: nonce + 1, sender: alice.address, receiver: bob.address, amountAtoms: 25 * ATOMS_PER_ZYN, feeAtoms: NODE_TRANSFER_FEE_ATOMS, timestampMs: Date.now() }, alice.privateKey, alice.publicKey, status.transactionVersion);
    assert.equal((await post("/tx", tx)).status, 200);
    await until("transfer", async () => (await get(`/account/${bob.address}`)).body.balanceAtoms === 25 * ATOMS_PER_ZYN);
    // Liveness with one validator down (3 of 4 is a quorum), then rejoin.
    const before = (await get("/status")).body.height;
    await network.stopValidator("v2");
    await until("finality with v2 stopped", async () => (await get("/status")).body.height >= before + 2, 360_000);
    network.startValidator("v2");
    const rejoined = await until("v2 rejoins the tip", async () => { const h = (await get("/status")).body.height; return (await allAt(h)) ? h : false; }, 360_000);
    // Sealed snapshot -> restore into a fresh directory -> same chain resumes.
    const snapshotResponse = await fetch(`${base}/state/snapshot`);
    assert.equal(snapshotResponse.status, 200);
    const sealed = Buffer.from(await snapshotResponse.arrayBuffer());
    assert.throws(() => openSnapshot(sealed, "x".repeat(40)));
    const snapHeight = Number(snapshotResponse.headers.get("x-zyron-snapshot-height"));
    await network.shutdown(); network = undefined;
    const restored = await restoreNetwork(join(dir, "restored"), openSnapshot(sealed, smokeSecret), info.chainId);
    assert.equal(restored.genesisHash, info.genesisHash);
    network = await runNetwork(join(dir, "restored"), { gatewayPort: 0, basePort: 19300 + Math.floor(Math.random() * 500) * 4, log: false, stateSecret: smokeSecret, persistence: { mode: "snapshot-restore" }, verifiedHistory: restored.verifiedHistory });
    const base2 = `http://127.0.0.1:${network.port}`;
    await until("restored chain finalizes past the snapshot", async () => { const s = await (await fetch(`${base2}/status`)).json(); return s.genesisHash === info.genesisHash && s.height > snapHeight; }, 360_000);
    assert.equal((await (await fetch(`${base2}/account/${bob.address}`)).json()).balanceAtoms, 25 * ATOMS_PER_ZYN);
    console.log(JSON.stringify({ ok: true, snapshotHeight: snapHeight, chainId: info.chainId, genesisHash: info.genesisHash, protocolVersion: 6, faucetTxid: drip.body.txid, transferTxid: tx.txid, heightAfterRestart: rejoined }, null, 2));
  } finally {
    if (network) await network.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}

// The CLI runs only when this file is executed directly; importing it (unit
// tests) loads the exported functions without dispatching a command.
const invokedDirectly = (() => {
  try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (!invokedDirectly) {
  // imported as a module: nothing to run
} else if (command === "init") {
  const dir = resolve(option("--dir"));
  const result = await initNetwork(dir, option("--chain-id", DEFAULT_CHAIN_ID));
  console.log(JSON.stringify({ chainId: result.chainId, genesisHash: result.genesisHash, faucetAddress: result.faucetAddress, directory: dir }, null, 2));
} else if (command === "run") {
  const dir = resolve(option("--dir"));
  const host = option("--host", "127.0.0.1");
  // Bind the public port first: download/decrypt/replay of a large snapshot on
  // a slow free instance can outlast the platform's port scan.
  const boot = createBootState();
  const server = createGatewayServer(createBootHandler(boot));
  const port = await listenGateway(server, Number(option("--port", process.env.PORT ?? "10000")), host);
  console.log(`gateway listening on ${host}:${port} (starting; full RPC once the validators are up)`);
  // --init-if-missing is for hosts without a persistent disk (for example a
  // free web service): a missing directory gets a fresh TEST genesis, so every
  // cold start is a new network with a new genesis hash.
  const stateSecret = process.env.ZYRON_TESTNET_STATE_SECRET || undefined;
  let persistence = { mode: "local-disk" };
  let verifiedHistory;
  const restoreUrl = option("--restore-url", process.env.ZYRON_TESTNET_STATE_URL || undefined);
  if (rest.includes("--init-if-missing")) {
    const exists = Boolean(await readNetworkMarker(dir));
    const chainId = option("--chain-id", process.env.ZYRON_TESTNET_CHAIN_ID ?? DEFAULT_CHAIN_ID);
    if (!exists) {
      const aside = await moveAsideIncompleteNetworkDir(dir);
      if (aside) console.log(`moved an incomplete network directory left by an interrupted start-up to ${aside}`);
    }
    if (!exists && restoreUrl && stateSecret) {
      try {
        boot.enter("download");
        const response = await downloadSnapshot(restoreUrl, { onAttempt: boot.progress, readBody: true });
        if (response.status === 404) {
          // A fresh TEST genesis only on an explicit operator decision: a
          // published chain whose asset is missing must not be silently replaced.
          if (process.env.ZYRON_TESTNET_ALLOW_FRESH_GENESIS !== "1") {
            console.error("STATE RESTORE FAILED (no state snapshot published after every retry); refusing to create a fresh TEST genesis without ZYRON_TESTNET_ALLOW_FRESH_GENESIS=1; stopping");
            await new Promise((done) => process.stderr.write("", done));
            process.exit(1);
          }
          console.log("no state snapshot published yet; ZYRON_TESTNET_ALLOW_FRESH_GENESIS=1 is set; creating a fresh TEST genesis");
        }
        else {
          assert.equal(response.status, 200, `snapshot download returned ${response.status}`);
          const sealed = response.bytes;
          console.log(`snapshot downloaded (${sealed.length} bytes)`);
          boot.enter("decrypt");
          const bundle = openSnapshot(sealed, stateSecret);
          boot.enter("replay");
          const restored = await restoreNetworkWithLocalRetry(dir, bundle, chainId, { onProgress: boot.progress });
          persistence = { mode: "snapshot-restore", restoredHeight: restored.height, restoredAtMs: Date.now() };
          verifiedHistory = restored.verifiedHistory;
          console.log(`restored ${restored.chainId} genesis ${restored.genesisHash} at height ${restored.height}`);
        }
      } catch (error) {
        if (error?.localIo) {
          // R37-1072-L1: never replace a published chain because this
          // instance's disk failed. No completion marker is written, so the
          // next start restores the published snapshot again.
          console.error(`STATE RESTORE FAILED (${error.message}); the published chain is kept (no new TEST genesis while the local disk fails); stopping so the host restarts the instance`);
          const aside = await moveAsideIncompleteNetworkDir(dir).catch((moveError) => { console.error(`could not move the failed restore directory aside: ${moveError instanceof Error ? moveError.message : String(moveError)}`); return false; });
          if (aside) console.error(`moved the failed restore directory to ${aside}`);
          // Let the log lines reach the host (pipes can be asynchronous) before exiting.
          await new Promise((done) => process.stderr.write("", done));
          await new Promise((done) => process.stdout.write("", done));
          process.exit(1);
        }
        // Fail closed: a snapshot that cannot be downloaded, decrypted or
        // re-validated (tampering, a wrong state secret, a non-200 answer after
        // every retry) must never be replaced by a fresh TEST genesis with new
        // keys under the same chain ID. Only a confirmed 404 (nothing published)
        // creates a fresh genesis. An operator who wants a new chain removes the
        // published snapshot.
        console.error(`STATE RESTORE FAILED (${error instanceof Error ? error.message : String(error)}); refusing to create a fresh TEST genesis under the published chain ID; stopping so the host restarts the instance`);
        const aside = await moveAsideIncompleteNetworkDir(dir).catch(() => false);
        if (aside) console.error(`moved the failed restore directory to ${aside}`);
        await new Promise((done) => process.stderr.write("", done));
        await new Promise((done) => process.stdout.write("", done));
        process.exit(1);
      }
    }
    if (!(await readNetworkMarker(dir))) {
      boot.enter("init");
      console.log(JSON.stringify(await initNetwork(dir, chainId, { onProgress: boot.progress })));
      persistence = { mode: exists ? "local-disk" : "fresh-genesis", createdAtMs: Date.now() };
    }
  }
  boot.enter("validators");
  // Followers are served only blocks inside a published snapshot when the
  // chain lives in published snapshots (ZYRON_TESTNET_DURABLE_PEERS=0 opts out).
  const durable = restoreUrl && stateSecret && process.env.ZYRON_TESTNET_DURABLE_PEERS !== "0" ? { fetchPublished: (() => { const cache = {}; return () => readPublishedSnapshotTip(restoreUrl, stateSecret, { cache }); })() } : undefined;
  const network = await runNetwork(dir, { stateSecret, persistence, host, server, verifiedHistory, durable, basePort: Number(option("--validator-base-port", "9300")) });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void network.shutdown().then(() => process.exit(0)); });
  if (await network.waitForQuorum()) {
    boot.enter("ready");
    console.log(`startup complete in ${Date.now() - boot.startedAtMs}ms; phase timings ${JSON.stringify(boot.timings)}`);
  } else console.error(`validators did not reach a quorum within ${parseStartupLimits().maxMs}ms of start-up`);
} else if (command === "smoke") {
  await smoke();
  process.exit(0);
} else {
  console.error("usage: open-testnet.mjs init --dir <dir> [--chain-id id] | run --dir <dir> [--port n] | smoke");
  process.exit(2);
}
