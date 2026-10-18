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
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { createReadStream, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
const { gatewayClientIdentity } = await import(dist("rpc-client-identity.js"));

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
// was moved.
export async function moveAsideIncompleteNetworkDir(dir) {
  let entries;
  try { entries = await readdir(dir); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (await readNetworkMarker(dir)) return false;
  const unexpected = entries.filter((name) => !NETWORK_DIR_ENTRIES.has(name));
  if (unexpected.length) throw new Error(`refusing to move ${dir}: unexpected entries ${unexpected.join(", ")}`);
  // The holder directory is reserved with an exclusive mkdir (an existing path
  // is skipped, never replaced); the directory then moves into it under its
  // own name, a path nothing else can have created.
  const base = `${dir}.incomplete-${Date.now()}-${process.pid}`;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const holder = attempt === 0 ? base : `${base}-${attempt}`;
    try { await mkdir(holder, { mode: 0o700 }); } catch (error) { if (error?.code === "EEXIST") continue; throw error; }
    const aside = join(holder, basename(dir));
    await rename(dir, aside);
    return aside;
  }
  throw new Error(`refusing to move ${dir}: no free name next to it`);
}
const V6_ACTIVATION_HEIGHT = 101;
const ATOMS_PER_ZYN = 100_000_000;
const FAUCET_DRIP_ATOMS = 100 * ATOMS_PER_ZYN;
const DAY_MS = 86_400_000;
const ADDRESS_PATTERN = /^ZYN[0-9a-f]{40}$/;
const MAX_BODY_BYTES = 8 * 1024;
const NOTICE = "TESTNET — tokens have no value. ZyronChain open testnet: test ZYN cannot be bought or sold, is not redeemable for mainnet ZYN, and the network may be reset at any time. Not audited.";
const SNAPSHOT_MAGIC = "ZYRON-OPEN-TESTNET-STATE-V1";
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const RESERVED_CHAIN_IDS = new Set(["zyron-mainnet-1", "zyron-public-testnet-1"]);

const STARTUP_GRACE_MS = 10 * 60_000;
// Boot liveness (download/decrypt/replay/init): /health stays 200 only while
// start-up makes progress (a phase change, a download attempt, a replayed
// block, a validator copy, a block produced or committed by a fresh init). Longer than one 180 s download attempt; no wall-clock cap,
// because a large snapshot on a slow instance replays for a long time.
export const BOOT_STALL_MS = 5 * 60_000;
const SNAPSHOT_DOWNLOAD_RETRY_DELAYS_MS = [2_000, 5_000];
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
const SECURITY = { "x-content-type-options": "nosniff", "x-zyron-network": "testnet-no-value", "referrer-policy": "no-referrer" };
function writeJson(response, code, body, extra = {}) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(code, { ...CORS, ...SECURITY, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload), ...extra });
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
// silent step. The destination is new (exclusive create) and owner-only.
async function copyFileWithProgress(source, destination, onChunk = () => {}) {
  const handle = await open(destination, "wx", 0o600);
  try {
    for await (const chunk of createReadStream(source)) {
      await handle.write(chunk);
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
  assert.equal(addressFromPublicKey(publicKeyFromPrivate(keys.faucet)), network.faucetAddress, "snapshot faucet key mismatch");
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
      onStateV2Batch: () => onProgress({ step: "open-state", validator: name })
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

// ---- init: fresh TEST keys, fixed-supply-v1 genesis, v6 prefix ----------------
export async function initNetwork(dir, chainId, { onProgress = () => {} } = {}) {
  assertTestnetChainId(chainId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const keyDir = join(dir, "keys");
  await mkdir(keyDir, { mode: 0o700 });
  const validators = VALIDATOR_NAMES.map(() => newAccount());
  const roles = { oracle: newAccount(), founder: newAccount(), faucet: newAccount(), liquidity: newAccount(), ecosystem: newAccount() };
  const plan = fixedSupplyPlanAtoms();
  const genesis = {
    chainId,
    timestampMs: Date.now() - 60_000,
    validators: validators.map(({ publicKey, address }) => ({ address, publicKey })),
    activityOracles: [roles.oracle.publicKey],
    activityPool: roles.ecosystem.address,
    allocations: [
      { address: roles.founder.address, amountAtoms: plan.founder },
      { address: roles.faucet.address, amountAtoms: plan.publicDistribution },
      { address: roles.liquidity.address, amountAtoms: plan.liquidityReserve },
      { address: roles.ecosystem.address, amountAtoms: plan.ecosystemReserve }
    ],
    allocationLocks: { founderVesting: roles.founder.address, permanentLiquidity: roles.liquidity.address },
    launchProfile: FIXED_SUPPLY_LAUNCH_PROFILE
  };
  const chain = new ZyronChain(genesis);
  for (const [index, name] of VALIDATOR_NAMES.entries()) await writeSecret(join(keyDir, `${name}.json`), { privateKey: validators[index].privateKey });
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
    launchProfile: FIXED_SUPPLY_LAUNCH_PROFILE, protocolV6ActivationHeight: V6_ACTIVATION_HEIGHT,
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
export async function runNetwork(dir, { gatewayPort, basePort = 9300, host = "127.0.0.1", log = true, stateSecret, persistence = { mode: "local-disk" }, server, verifiedHistory } = {}) {
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
  const nodes = new Map();
  let shuttingDown = false;

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
      try {
        const [status, ready] = await Promise.all([nodeFetch(node.port, "/status"), nodeFetch(node.port, "/readyz")]);
        return { name, up: true, height: status.body.height, tipHash: status.body.tipHash, ready: ready.status === 200 };
      } catch { return { name, up: false }; }
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
      launchProfile: genesis.launchProfile, height: status.body.height, tipHash: status.body.tipHash,
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
    snapshot: new WindowLimiter(30, 3_600_000, 1)
  };
  let snapshotCache; let snapshotCacheAt = 0; let snapshotBuild;
  // Verified history (R28-1059): from the restore replay when there was one,
  // otherwise validated from genesis on the first build.
  const snapshotHistory = verifiedHistory ?? createSnapshotHistory(genesis);
  // One build at a time: concurrent requests share it, and the verified
  // history is never extended twice in parallel.
  function buildSnapshot() {
    if (snapshotCache && Date.now() - snapshotCacheAt < 60_000) return Promise.resolve(snapshotCache);
    snapshotBuild ??= buildSnapshotNow().finally(() => { snapshotBuild = undefined; });
    return snapshotBuild;
  }
  async function buildSnapshotNow() {
    const { height: tip, tipHash } = await chainStatus();
    const readers = VALIDATOR_NAMES.map((name) => ({
      name,
      async read(from, limit) {
        const node = nodes.get(name);
        if (!node || node.exit) throw new Error("validator not running");
        const result = await nodeFetch(node.port, `/blocks?from=${from}&limit=${limit}`);
        if (result.status !== 200 || !Array.isArray(result.body?.blocks)) throw new Error(`block read returned ${result.status}`);
        return result.body.blocks;
      }
    }));
    const blocks = await collectSnapshotBlocks(readers, {
      tip, tipHash, chainId, genesisHash: info.genesisHash, history: snapshotHistory,
      onReject: (name, error) => console.error(`snapshot: history from ${name} not used (${error instanceof Error ? error.message : String(error)})`)
    });
    const keys = {};
    for (const name of [...VALIDATOR_NAMES, "oracle", "founder", "faucet", "liquidity", "ecosystem"]) keys[name] = (await readSecret(join(dir, "keys", `${name}.json`))).privateKey;
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
      if (nonceResponse.status !== 200) throw new Error("faucet nonce unavailable");
      if (Date.now() - lastFaucetNonceAt > 180_000) lastFaucetNonce = 0;
      const nonce = Math.max(nonceResponse.body.nonce, lastFaucetNonce) + 1;
      const tx = createTransfer({ chainId, nonce, sender: faucet.address, receiver, amountAtoms: FAUCET_DRIP_ATOMS, feeAtoms: 0, timestampMs: Date.now() },
        faucet.privateKey, faucet.publicKey, status.transactionVersion);
      const submitted = await anyNode("/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
      if (submitted.status < 200 || submitted.status > 299) throw Object.assign(new Error(`faucet transfer rejected: ${String(submitted.body?.error ?? submitted.status).slice(0, 200)}`), { statusCode: 503 });
      lastFaucetNonce = nonce; lastFaucetNonceAt = Date.now();
      return { txid: tx.txid, receiver, amountAtoms: FAUCET_DRIP_ATOMS, nonce };
    });
    faucetQueue = run.catch(() => undefined);
    return run;
  }

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
  const handler = async (request, response) => {
    if (active >= 64) return sendJson(response, 503, { error: "busy, retry shortly" }, { "retry-after": "1" });
    active += 1; response.once("close", () => { active -= 1; });
    try {
      const rawUrl = request.url ?? "/";
      if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.length > 256 || /[\u0000-\u001f\u007f\\]/.test(rawUrl)) return sendJson(response, 400, { error: "invalid request target" });
      const url = new URL(rawUrl, "http://gateway.invalid");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (request.method === "OPTIONS") { response.writeHead(204, CORS); return response.end(); }
      const ip = clientIp(request);
      if (request.method === "GET") {
        if (path === "/health" || path === "/healthz" || path === "/readyz") {
          const { validators, checkedAtMs } = await cachedValidatorStatuses();
          const up = validators.filter((v) => v.up);
          const heights = up.map((v) => v.height);
          const quorum = Math.floor((2 * genesis.validators.length) / 3) + 1;
          const ok = up.length >= quorum;
          if (ok) everReady = true;
          // Until the validators first reach a quorum (bounded by STARTUP_GRACE_MS)
          // liveness stays 200 "starting"; afterwards a lost quorum is a 503.
          // /readyz is always strict.
          const starting = !ok && !everReady && Date.now() - runStartedAtMs < STARTUP_GRACE_MS;
          const status = ok ? "ready" : starting ? "starting" : "degraded";
          const code = ok || (starting && path !== "/readyz") ? 200 : 503;
          return sendJson(response, code, { ok, status, ...(starting ? { phase: "validators" } : {}), network: "testnet", valueBearing: false, chainId, persistence, quorum, validatorsUp: up.length, maxHeight: heights.length ? Math.max(...heights) : null, checkedAtMs, validators });
        }
        const rate = limits.read.take(ip);
        if (!rate.allowed) return limited(response, rate);
        // Read-only peer surface for volunteer follower nodes (`node --peer <gateway>/peer`):
        // raw /status and /blocks only. Validator P2P write paths are never exposed.
        if (path === "/peer/status") {
          const result = await anyNode("/status");
          return sendJson(response, result.status === 200 ? 200 : 502, result.status === 200 ? result.body : { error: "node unavailable" }, PEER_RPC);
        }
        if (path === "/peer/blocks") {
          const from = Number.parseInt(url.searchParams.get("from") ?? "", 10);
          const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
          if (!Number.isSafeInteger(from) || from < 1) return sendJson(response, 400, { error: "from must be a positive integer" });
          const result = await anyNode(`/blocks?from=${from}&limit=${limit}`);
          return sendJson(response, result.status === 200 ? 200 : 502, result.status === 200 ? result.body : { error: "node unavailable" }, PEER_RPC);
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
        if (path === "/status" || path === "/chain") return sendJson(response, 200, await chainStatus());
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
          const blocks = result.body.blocks.map(summarizeBlock);
          return sendJson(response, 200, path === "/blocks" ? { network: "testnet", tip, blocks } : blocks[0]);
        }
        for (const prefix of ["/balance/", "/nonce/", "/account/"]) {
          if (!path.startsWith(prefix)) continue;
          const address = path.slice(prefix.length);
          if (!ADDRESS_PATTERN.test(address)) return sendJson(response, 400, { error: "invalid address" });
          const [balance, nonce] = await Promise.all([anyNode(`/balance/${address}`), anyNode(`/nonce/${address}`)]);
          if (balance.status !== 200 || nonce.status !== 200) return sendJson(response, 502, { error: "node unavailable" });
          const body = { network: "testnet", chainId, height: (await chainStatus()).height, address, balanceAtoms: balance.body.balanceAtoms, nonce: nonce.body.nonce };
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
          return sendJson(response, 200, { accepted: true, txid: submitted.body.txid, note: "Included in a coming block (about 30 seconds)." });
        }
        if (path === "/faucet") {
          const ipRate = limits.faucetIp.take(ip);
          if (!ipRate.allowed) return limited(response, ipRate);
          const body = await readJsonBody(request);
          const address = body && typeof body === "object" ? body.address : undefined;
          if (typeof address !== "string" || !ADDRESS_PATTERN.test(address) || address === faucet.address) return sendJson(response, 400, { error: "body must be {\"address\":\"ZYN...\"}" });
          const addressRate = limits.faucetAddress.take(address);
          if (!addressRate.allowed) return limited(response, addressRate);
          const globalRate = limits.faucetGlobal.take("global");
          if (!globalRate.allowed) return limited(response, globalRate);
          const result = await faucetSend(address);
          return sendJson(response, 200, { ...result, network: "testnet", valueBearing: false, note: "TESTNET — tokens have no value. Arrives in a coming block (about 30 seconds)." });
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
    await Promise.all(VALIDATOR_NAMES.map((name) => stopValidator(name)));
  }
  async function waitForQuorum(timeoutMs = STARTUP_GRACE_MS) {
    const quorum = Math.floor((2 * genesis.validators.length) / 3) + 1;
    const deadline = Date.now() + timeoutMs;
    while (!shuttingDown && Date.now() < deadline) {
      const up = (await validatorStatuses()).filter((v) => v.up).length;
      if (up >= quorum) return true;
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
    const tx = createTransfer({ chainId: info.chainId, nonce: nonce + 1, sender: alice.address, receiver: bob.address, amountAtoms: 25 * ATOMS_PER_ZYN, feeAtoms: 0, timestampMs: Date.now() }, alice.privateKey, alice.publicKey, status.transactionVersion);
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
  if (rest.includes("--init-if-missing")) {
    const exists = Boolean(await readNetworkMarker(dir));
    const chainId = option("--chain-id", process.env.ZYRON_TESTNET_CHAIN_ID ?? DEFAULT_CHAIN_ID);
    const restoreUrl = option("--restore-url", process.env.ZYRON_TESTNET_STATE_URL || undefined);
    if (!exists) {
      const aside = await moveAsideIncompleteNetworkDir(dir);
      if (aside) console.log(`moved an incomplete network directory left by an interrupted start-up to ${aside}`);
    }
    if (!exists && restoreUrl && stateSecret) {
      try {
        boot.enter("download");
        let response;
        for (let attempt = 0; ; attempt += 1) {
          // Transient download failures are retried; only a decrypt/validation
          // failure or a missing snapshot falls back to a fresh genesis.
          try {
            boot.progress();
            response = await fetch(restoreUrl, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
            if (response.status === 200 || response.status === 404 || attempt >= SNAPSHOT_DOWNLOAD_RETRY_DELAYS_MS.length) break;
            console.error(`snapshot download returned ${response.status}; retrying`);
          } catch (error) {
            if (attempt >= SNAPSHOT_DOWNLOAD_RETRY_DELAYS_MS.length) throw error;
            console.error(`snapshot download failed (${error instanceof Error ? error.message : String(error)}); retrying`);
          }
          await sleep(SNAPSHOT_DOWNLOAD_RETRY_DELAYS_MS[attempt]);
        }
        if (response.status === 404) console.log("no state snapshot published yet; creating a fresh TEST genesis");
        else {
          assert.equal(response.status, 200, `snapshot download returned ${response.status}`);
          const sealed = Buffer.from(await response.arrayBuffer());
          console.log(`snapshot downloaded (${sealed.length} bytes)`);
          boot.enter("decrypt");
          const bundle = openSnapshot(sealed, stateSecret);
          boot.enter("replay");
          const restored = await restoreNetwork(dir, bundle, chainId, { onProgress: boot.progress });
          persistence = { mode: "snapshot-restore", restoredHeight: restored.height, restoredAtMs: Date.now() };
          verifiedHistory = restored.verifiedHistory;
          console.log(`restored ${restored.chainId} genesis ${restored.genesisHash} at height ${restored.height}`);
        }
      } catch (error) {
        console.error(`STATE RESTORE FAILED (${error instanceof Error ? error.message : String(error)}); creating a fresh TEST genesis`);
        const aside = await moveAsideIncompleteNetworkDir(dir);
        if (aside) console.error(`moved the failed restore directory to ${aside}`);
      }
    }
    if (!(await readNetworkMarker(dir))) {
      boot.enter("init");
      console.log(JSON.stringify(await initNetwork(dir, chainId, { onProgress: boot.progress })));
      persistence = { mode: exists ? "local-disk" : "fresh-genesis", createdAtMs: Date.now() };
    }
  }
  boot.enter("validators");
  const network = await runNetwork(dir, { stateSecret, persistence, host, server, verifiedHistory, basePort: Number(option("--validator-base-port", "9300")) });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void network.shutdown().then(() => process.exit(0)); });
  if (await network.waitForQuorum()) {
    boot.enter("ready");
    console.log(`startup complete in ${Date.now() - boot.startedAtMs}ms; phase timings ${JSON.stringify(boot.timings)}`);
  } else console.error(`validators did not reach a quorum within ${STARTUP_GRACE_MS}ms of start-up`);
} else if (command === "smoke") {
  await smoke();
  process.exit(0);
} else {
  console.error("usage: open-testnet.mjs init --dir <dir> [--chain-id id] | run --dir <dir> [--port n] | smoke");
  process.exit(2);
}
