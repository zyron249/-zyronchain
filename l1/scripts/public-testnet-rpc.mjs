#!/usr/bin/env node
// ZyronChain wallet testnet RPC: one loopback validator + a small public HTTP
// gateway (read API, transfer submit, rate-limited test faucet, CORS, /health).
//
// TESTNET ONLY. Test ZYN on this network has no value and can be reset at any
// time. This profile never touches the 50M fixed-supply mainnet allocation or
// its keys: every key here is generated (or derived from an operator-provided
// testnet seed) at runtime, and the genesis allocates only small test amounts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAddressInput, toChecksumAddress } from "../dist/src/address-checksum.js";
import { ZyronChain } from "../dist/src/chain.js";
import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { createTransfer } from "../dist/src/transaction.js";
import { gatewayClientIdentity } from "../dist/src/rpc-client-identity.js";
import { connectWalletTestnetDatabase, planStateRestore } from "./wallet-testnet-durable.mjs";
import { createFaucetNonceTracker } from "./faucet-nonce.mjs";
import { faucetTransferFeeAtoms } from "./faucet-fee.mjs";
import { submitAcceptedView } from "./submit-view.mjs";

export const DEFAULT_CHAIN_ID = "zyron-wallet-testnet-1";
const ATOMS_PER_ZYN = 100_000_000;
const FAUCET_ALLOCATION_ATOMS = 1_000_000 * ATOMS_PER_ZYN;
const VALIDATOR_ALLOCATION_ATOMS = 1 * ATOMS_PER_ZYN;
const POOL_ALLOCATION_ATOMS = 1 * ATOMS_PER_ZYN;
const CONFIGURED_TEST_SUPPLY_ATOMS = FAUCET_ALLOCATION_ATOMS + VALIDATOR_ALLOCATION_ATOMS + POOL_ALLOCATION_ATOMS;
const FAUCET_DRIP_ATOMS = 100 * ATOMS_PER_ZYN;
const DAY_MS = 24 * 60 * 60 * 1000;
const ADDRESS_PATTERN = /^ZYN[0-9a-f]{40}$/;
const MAX_BODY_BYTES = 8 * 1024;
const NOTICE = "ZyronChain wallet TESTNET. Test ZYN has no value, cannot be bought or sold, and is not mainnet. Balances and nonces survive a restart only when durable storage is on. The network can still be reset at any time.";

const smokeMode = process.argv.includes("--smoke");
const chainId = process.env.ZYRON_TESTNET_CHAIN_ID ?? DEFAULT_CHAIN_ID;
if (!/^[a-z0-9-]{3,64}$/.test(chainId) || !chainId.includes("testnet")) {
  throw new Error("ZYRON_TESTNET_CHAIN_ID must be a valid chain ID containing 'testnet'");
}
if (chainId === "zyron-public-testnet-1") {
  throw new Error("zyron-public-testnet-1 is reserved for the gated public testnet genesis; use another chain ID");
}
const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = resolve(l1Root, "dist/src/cli.js");
const nodePort = Number(process.env.ZYRON_TESTNET_NODE_PORT ?? 9237);
const gatewayPort = smokeMode ? 0 : Number(process.env.PORT ?? 10000);
const trustProxy = process.env.ZYRON_TRUST_PROXY === "1";
// Legacy consensus derives the round from (now - tip time), so a fresh chain
// must start from a recent genesis time. The genesis hash therefore changes on
// each process start even when balances were restored from durable storage.
// A hash change is not, by itself, a wipe.
const genesisTimestampMs = Date.now() - 60_000;
assert.ok(Number.isSafeInteger(nodePort) && nodePort > 1024 && nodePort < 65535, "invalid ZYRON_TESTNET_NODE_PORT");

// ---- keys and genesis ------------------------------------------------------
// With ZYRON_TESTNET_SEED (a testnet-only secret, 32+ characters) the
// validator and faucet keys are identical across restarts. Disk state is
// ephemeral. ZYRON_TESTNET_DATABASE_URL, when it connects, restores included
// transfers and faucet daily limits. The seed must stay the same or a faucet
// transfer signed by the previous key cannot be replayed.
const seedSecret = process.env.ZYRON_TESTNET_SEED;
if (seedSecret !== undefined) assert.ok(seedSecret.length >= 32 && seedSecret.length <= 256, "ZYRON_TESTNET_SEED must be 32-256 characters");
const seed = seedSecret ? createHash("sha256").update(`zyronchain/wallet-testnet-seed/${seedSecret}`).digest() : randomBytes(32);
function deriveKey(label) {
  for (let counter = 0; counter < 16; counter += 1) {
    const candidate = createHmac("sha256", seed).update(`zyronchain/wallet-testnet/${chainId}/${label}/${counter}`).digest("hex");
    try { publicKeyFromPrivate(candidate); return candidate; } catch { /* out of range, try next */ }
  }
  return generatePrivateKey();
}
function account(label) {
  const privateKey = deriveKey(label);
  const publicKey = publicKeyFromPrivate(privateKey);
  return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
}
const validator = account("validator");
const faucet = account("faucet");
const oracle = account("activity-oracle");
const pool = account("activity-pool");
let genesis = {
  chainId,
  timestampMs: genesisTimestampMs,
  validators: [{ publicKey: validator.publicKey, address: validator.address }],
  activityOracles: [oracle.publicKey],
  activityPool: pool.address,
  allocations: [
    { address: validator.address, amountAtoms: VALIDATOR_ALLOCATION_ATOMS },
    { address: faucet.address, amountAtoms: FAUCET_ALLOCATION_ATOMS },
    { address: pool.address, amountAtoms: POOL_ALLOCATION_ATOMS }
  ]
};
// stateDurable is true only when this process will record new inclusions.
// restoredTxCount / restoredAccounts describe what this start recovered.
let durable = null;
let restoreMode = "none";
let restoreEntries = [];
let plannedRestore = { restoredTxCount: 0, restoredAccounts: 0 };
let faucetSeed = [];
let stateDurable = false;
let restoredTxCount = 0;
let restoredAccounts = 0;
let restoreReady = true;
const databaseUrl = process.env.ZYRON_TESTNET_DATABASE_URL?.trim();
if (databaseUrl) {
  try {
    durable = await connectWalletTestnetDatabase(databaseUrl);
    const loaded = await durable.load(chainId);
    const plan = planStateRestore({
      genesis,
      entries: loaded.entries,
      baseline: loaded.baseline,
      nowMs: Date.now(),
      validatorPrivateKey: validator.privateKey,
      configuredSupplyAtoms: CONFIGURED_TEST_SUPPLY_ATOMS
    });
    if (plan.baselineToSave) await durable.saveBaseline(chainId, plan.baselineToSave);
    if (plan.error) console.warn(`wallet testnet restore: ${plan.error}`);
    if (plan.mode === "abort" && plan.severe) {
      console.warn("wallet testnet durable restore aborted; starting non-durable so new transfers are not appended to an unusable log");
      await durable.close();
      durable = null;
    } else {
      // A non-window failure with a saved baseline keeps those balances and
      // does not replay the bad tail. Chain nonces in that baseline are 0
      // unless a later replay advances them.
      genesis = plan.genesis;
      if (plan.mode === "abort") {
        restoreMode = "none";
        restoredAccounts = plan.restoredAccounts;
      } else {
        restoreMode = plan.mode;
        restoreEntries = plan.entries;
        plannedRestore = { restoredTxCount: plan.restoredTxCount, restoredAccounts: plan.restoredAccounts };
        if (plan.mode === "replay") restoreReady = false;
        else {
          restoredTxCount = plan.restoredTxCount;
          restoredAccounts = plan.restoredAccounts;
        }
      }
      faucetSeed = await durable.loadFaucetLimits(chainId);
    }
    stateDurable = Boolean(durable);
  } catch (error) {
    console.warn(`wallet testnet durable state unavailable; starting non-durable: ${error instanceof Error ? error.message : String(error)}`);
    if (durable) await durable.close().catch(() => undefined);
    durable = null;
    stateDurable = false;
    restoreMode = "none";
    restoreReady = true;
    restoreEntries = [];
  }
}
const genesisHash = new ZyronChain(genesis).genesisHash;

const explicitRoot = process.env.ZYRON_TESTNET_DATA_ROOT;
const root = explicitRoot ? resolve(explicitRoot) : await mkdtemp(join(tmpdir(), "zyron-wallet-testnet-"));
await mkdir(root, { recursive: true });
const genesisPath = join(root, "genesis.json");
const keyPath = join(root, "validator.json");
const dataDir = join(root, "validator-data");
await writeFile(genesisPath, `${JSON.stringify(genesis, null, 2)}\n`, { mode: 0o644 });
await writeFile(keyPath, `${JSON.stringify({ privateKey: validator.privateKey })}\n`, { mode: 0o600 });

// ---- validator process -----------------------------------------------------
let child;
let shuttingDown = false;
function startValidator() {
  child = spawn(process.execPath, [
    cliPath, "node",
    "--genesis", genesisPath,
    "--data", dataDir,
    "--host", "127.0.0.1",
    "--port", String(nodePort),
    "--validator-key", keyPath,
    // P1-02-M3: the validator is reachable only over loopback by this gateway,
    // which enforces the public per-client limits; without the exemption all
    // public traffic shared one node RPC quota for 127.0.0.1.
    "--rpc-rate-limit-exempt", "127.0.0.1"
  ], { cwd: l1Root, stdio: ["ignore", "inherit", "inherit"] });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`validator exited unexpectedly: code=${code} signal=${signal}`);
    void shutdown("validator-exit", 1);
  });
}

async function nodeFetch(path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${nodePort}${path}`, {
    ...init,
    headers: { "x-zyron-rpc-version": "1", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8_000)
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: "invalid node response" }; }
  return { status: response.status, body };
}

let statusCache;
let statusCacheAt = 0;
let statusInFlight;
// P1-02-L1: /health is not rate limited; concurrent requests share one
// in-flight node status check instead of each fanning out on a cache miss.
function chainStatus() {
  if (statusCache && Date.now() - statusCacheAt < 1_000) return Promise.resolve(statusCache);
  statusInFlight ??= fetchChainStatus().finally(() => { statusInFlight = undefined; });
  return statusInFlight;
}
async function fetchChainStatus() {
  const [status, protocol] = await Promise.all([nodeFetch("/status"), nodeFetch("/protocol")]);
  if (status.status !== 200) throw new Error("node not ready");
  const nextProtocol = protocol.status === 200 ? protocol.body.nextVersion : 1;
  statusCache = {
    network: "testnet",
    valueBearing: false,
    notice: NOTICE,
    chainId: status.body.chainId,
    genesisHash: status.body.genesisHash,
    height: status.body.height,
    tipHash: status.body.tipHash,
    protocolVersion: nextProtocol,
    transactionVersion: nextProtocol >= 3 ? 2 : 1,
    blockIntervalSeconds: 30,
    faucet: { address: faucet.address, dripZyn: FAUCET_DRIP_ATOMS / ATOMS_PER_ZYN, perAddressPerDay: 1 },
    stateDurable,
    restoredTxCount,
    restoredAccounts
  };
  statusCacheAt = Date.now();
  return statusCache;
}

// ---- rate limiting ---------------------------------------------------------
class WindowLimiter {
  constructor(limit, windowMs, maxKeys = 50_000) { Object.assign(this, { limit, windowMs, maxKeys, hits: new Map() }); }
  take(key, now = Date.now()) {
    let entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (!entry && this.hits.size >= this.maxKeys) this.sweep(now);
      if (!entry && this.hits.size >= this.maxKeys) return { allowed: false, retryAfterMs: this.windowMs };
      entry = { start: now, count: 0 };
      this.hits.set(key, entry);
    }
    if (entry.count >= this.limit) return { allowed: false, retryAfterMs: entry.start + this.windowMs - now };
    entry.count += 1;
    return { allowed: true };
  }
  snapshot(key) {
    const entry = this.hits.get(key);
    return entry ? { start: entry.start, count: entry.count } : null;
  }
  restore(key, start, count) {
    if (typeof key !== "string" || key.length < 1 || key.length > 200) return;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0) return;
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) return;
    this.hits.set(key, { start, count });
  }
  sweep(now) { for (const [key, entry] of this.hits) if (now - entry.start >= this.windowMs) this.hits.delete(key); }
}
const limits = {
  read: new WindowLimiter(Number(process.env.ZYRON_RPC_READS_PER_MINUTE ?? 120), 60_000),
  write: new WindowLimiter(Number(process.env.ZYRON_RPC_TX_PER_MINUTE ?? 10), 60_000),
  faucetIp: new WindowLimiter(5, DAY_MS),
  faucetAddress: new WindowLimiter(1, DAY_MS),
  faucetGlobal: new WindowLimiter(200, 60 * 60 * 1000, 1)
};
for (const row of faucetSeed) {
  const limiter = row.bucket === "address" ? limits.faucetAddress : row.bucket === "ip" ? limits.faucetIp : row.bucket === "global" ? limits.faucetGlobal : null;
  if (!limiter) continue;
  if (!Number.isSafeInteger(row.windowStartMs) || Date.now() - row.windowStartMs >= limiter.windowMs) continue;
  limiter.restore(row.subject, row.windowStartMs, row.hits);
}
async function persistFaucetLimit(bucket, key, limiter) {
  if (!durable) return;
  const snap = limiter.snapshot(key);
  if (!snap) return;
  try {
    await durable.saveFaucetLimit(chainId, bucket, key, snap.start, snap.count);
  } catch (error) {
    console.warn(`wallet testnet faucet limit was not saved: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Rate-limit identity (P1-02). ZYRON_TRUST_PROXY=1 means the service runs
// behind Render's Cloudflare edge, which sets CF-Connecting-IP; the leftmost
// X-Forwarded-For entry is client-supplied text and is never used. IPv6
// clients share one bucket per /64.
function clientIp(request) {
  return gatewayClientIdentity(request.socket.remoteAddress, request.headers, { trustCloudflareConnectingIp: trustProxy });
}

// ---- faucet ----------------------------------------------------------------
let faucetQueue = Promise.resolve();
const faucetNonce = createFaucetNonceTracker();
function faucetSend(receiver) {
  const run = faucetQueue.then(async () => {
    const status = await chainStatus();
    // Fresh read of the node's fee floor (or fixed fee) from GET /status; a
    // missing or invalid floor fails the drip (FaucetFeeFloorError).
    const feeAtoms = faucetTransferFeeAtoms(0, await nodeFetch("/status"));
    const nonceResponse = await nodeFetch(`/nonce/${faucet.address}`);
    if (nonceResponse.status !== 200) throw new Error("faucet nonce unavailable");
    const chainNonce = nonceResponse.body.nonce;
    // Chain state wins after a restore, a rejected drip, or 3 minutes
    // (Red Team INFO #9); a dropped faucet transaction cannot leave a gap.
    const nonce = faucetNonce.next(chainNonce, Date.now());
    const tx = createTransfer(
      { chainId, nonce, sender: faucet.address, receiver, amountAtoms: FAUCET_DRIP_ATOMS, feeAtoms, timestampMs: Date.now() },
      faucet.privateKey, faucet.publicKey, status.transactionVersion
    );
    const submitted = await nodeFetch("/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
    if (submitted.status < 200 || submitted.status > 299) { faucetNonce.rejected(nonce, { status: submitted.status, error: submitted.body?.error }, Date.now()); throw new Error(`faucet transfer rejected: ${submitted.body?.error ?? submitted.status}`); }
    faucetNonce.accepted(nonce, Date.now());
    return { txid: tx.txid, receiver, amountAtoms: FAUCET_DRIP_ATOMS, nonce };
  });
  faucetQueue = run.catch(() => undefined);
  return run;
}

// ---- gateway ---------------------------------------------------------------
const CORS_HEADERS = {
  // Snaps fetch with origin "null", so the public testnet API allows any origin.
  // Nothing here uses cookies or credentials.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600"
};
function sendJson(response, statusCode, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(statusCode, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
    "x-zyron-network": "testnet-no-value",
    ...extraHeaders
  });
  response.end(payload);
}
function limited(response, result) {
  return sendJson(response, 429, { error: "rate limit exceeded" }, { "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) });
}
async function readJsonBody(request) {
  const type = request.headers["content-type"] ?? "";
  if (!String(type).toLowerCase().startsWith("application/json")) throw Object.assign(new Error("content-type must be application/json"), { statusCode: 415 });
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 400 }); }
}
// Display checksum (docs/ADDRESS_CHECKSUM.md) is accepted on read and faucet
// routes and folded to the canonical lowercase form before any node call or
// rate-limit key. A wrong checksum is rejected; it is never "fixed".
function canonicalAddress(input) {
  if (typeof input !== "string" || input.length > 80) return { error: "invalid address" };
  try {
    return { canonical: parseAddressInput(input).canonical };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid address" };
  }
}
function addressFrom(path, prefix) {
  let value;
  try { value = decodeURIComponent(path.slice(prefix.length)); } catch { return { error: "invalid address" }; }
  return canonicalAddress(value);
}
// POST /tx is forwarded byte-for-byte. Rewriting sender or receiver would
// change the signed canonical JSON and make a valid signature fail, so a
// checksummed or otherwise non-canonical address is rejected with the
// lowercase form the client should submit instead.
function nonCanonicalTxAddress(tx) {
  if (!tx || typeof tx !== "object") return undefined;
  for (const field of ["sender", "receiver"]) {
    const value = tx[field];
    if (typeof value !== "string" || ADDRESS_PATTERN.test(value)) continue;
    const parsed = canonicalAddress(value);
    if (parsed.error) return `${field}: ${parsed.error}`;
    return `${field} must be the canonical lowercase address ${parsed.canonical}. POST /tx does not rewrite addresses: the signature covers sender and receiver, so a checksummed or mixed-case form would not verify. Submit the lowercase form.`;
  }
  return undefined;
}

let activeRequests = 0;
const gateway = createServer({ headersTimeout: 5_000, requestTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16_384 }, async (request, response) => {
  if (activeRequests >= 64) return sendJson(response, 503, { error: "busy, retry shortly" }, { "retry-after": "1" });
  activeRequests += 1;
  response.once("close", () => { activeRequests -= 1; });
  try {
    const rawUrl = request.url ?? "/";
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.length > 256 || /[\u0000-\u001f\u007f\\]/.test(rawUrl)) {
      return sendJson(response, 400, { error: "invalid request target" });
    }
    const path = new URL(rawUrl, "http://gateway.invalid").pathname.replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS);
      return response.end();
    }
    const ip = clientIp(request);
    if (request.method === "GET" && (path === "/health" || path === "/healthz")) {
      const alive = child && child.exitCode === null && child.signalCode === null;
      let height = null;
      try { height = (await chainStatus()).height; } catch { /* starting */ }
      return sendJson(response, alive && height !== null ? 200 : 503, { ok: Boolean(alive && height !== null), network: "testnet", valueBearing: false, chainId, height });
    }
    // /health stays available while included transfers are replayed so the host
    // does not restart the process. Other routes wait so clients do not read
    // the empty pre-replay balances or submit a conflicting nonce.
    if (!restoreReady) return sendJson(response, 503, { error: "Restoring saved testnet state. Try again in a moment." }, { "retry-after": "2" });
    if (request.method === "GET") {
      const rate = limits.read.take(ip);
      if (!rate.allowed) return limited(response, rate);
      if (path === "/" ) {
        return sendJson(response, 200, {
          name: "ZyronChain wallet testnet RPC",
          ...(await chainStatus()),
          endpoints: ["GET /health", "GET /status", "GET /supply", "GET /account/{address}", "GET /balance/{address}", "GET /nonce/{address}", "POST /tx", "POST /faucet {address}"]
        });
      }
      if (path === "/status" || path === "/chain") return sendJson(response, 200, await chainStatus());
      if (path === "/genesis") return sendJson(response, 200, { network: "testnet", valueBearing: false, genesisHash, genesis });
      if (path === "/supply") {
        const result = await nodeFetch("/supply");
        if (result.status !== 200) return sendJson(response, 502, { error: "node unavailable" });
        return sendJson(response, 200, { network: "testnet", valueBearing: false, ...result.body });
      }
      for (const prefix of ["/balance/", "/nonce/", "/account/"]) {
        if (!path.startsWith(prefix)) continue;
        const parsed = addressFrom(path, prefix);
        if (parsed.error) return sendJson(response, 400, { error: parsed.error });
        const address = parsed.canonical;
        const [balance, nonce] = await Promise.all([nodeFetch(`/balance/${address}`), nodeFetch(`/nonce/${address}`)]);
        if (balance.status !== 200 || nonce.status !== 200) return sendJson(response, 502, { error: "node unavailable" });
        const status = await chainStatus();
        const body = { network: "testnet", chainId, height: status.height, address, balanceAtoms: balance.body.balanceAtoms, nonce: nonce.body.nonce };
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
        const addressError = nonCanonicalTxAddress(tx);
        if (addressError) return sendJson(response, 400, { error: addressError });
        const submitted = await nodeFetch("/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
        if (submitted.status < 200 || submitted.status > 299) return sendJson(response, 400, { error: String(submitted.body?.error ?? "rejected").slice(0, 300) });
        return sendJson(response, 200, submitAcceptedView(submitted.body));
      }
      if (path === "/faucet") {
        const ipRate = limits.faucetIp.take(ip);
        if (ipRate.allowed) await persistFaucetLimit("ip", ip, limits.faucetIp);
        if (!ipRate.allowed) return limited(response, ipRate);
        const body = await readJsonBody(request);
        const rawAddress = body && typeof body === "object" ? body.address : undefined;
        if (typeof rawAddress !== "string") return sendJson(response, 400, { error: "body must be {\"address\":\"ZYN...\"}" });
        const parsed = canonicalAddress(rawAddress);
        if (parsed.error) return sendJson(response, 400, { error: parsed.error });
        const address = parsed.canonical;
        if (address === faucet.address) return sendJson(response, 400, { error: "invalid address" });
        const addressRate = limits.faucetAddress.take(address);
        if (addressRate.allowed) await persistFaucetLimit("address", address, limits.faucetAddress);
        if (!addressRate.allowed) return limited(response, addressRate);
        const globalRate = limits.faucetGlobal.take("global");
        if (globalRate.allowed) await persistFaucetLimit("global", "global", limits.faucetGlobal);
        if (!globalRate.allowed) return limited(response, globalRate);
        const result = await faucetSend(address);
        return sendJson(response, 200, { ...result, network: "testnet", valueBearing: false, note: "Test ZYN, no value. Arrives in the next block (about 30 seconds)." });
      }
      return sendJson(response, 404, { error: "not found" });
    }
    return sendJson(response, 405, { error: "method not allowed" });
  } catch (error) {
    const statusCode = error?.statusCode ?? 500;
    if (statusCode === 500) console.error(`gateway error: ${error instanceof Error ? error.message : String(error)}`);
    return sendJson(response, statusCode, { error: statusCode === 500 ? "internal error" : error.message });
  }
});
gateway.maxConnections = 256;

let scannedHeight = 0;
let scanTimer;
let scanChain = Promise.resolve();

function scheduleScan() {
  if (!durable) return Promise.resolve();
  scanChain = scanChain.then(() => scanIncludedTransactions()).catch((error) => {
    console.warn(`wallet testnet inclusion scan failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return scanChain;
}

async function scanIncludedTransactions(force = false) {
  if (!durable || (shuttingDown && !force)) return;
  let from = scannedHeight + 1;
  for (;;) {
    if (shuttingDown && !force) return;
    const res = await nodeFetch(`/blocks?from=${from}&limit=50`);
    if (res.status !== 200 || !Array.isArray(res.body?.blocks) || res.body.blocks.length === 0) return;
    for (const block of res.body.blocks) {
      const height = block?.header?.height;
      for (const tx of block.transactions ?? []) {
        if (tx?.kind === "transfer") await durable.insertIncluded(chainId, tx);
      }
      if (Number.isSafeInteger(height)) scannedHeight = height;
    }
    from = scannedHeight + 1;
  }
}

async function waitForNodeReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    const res = await nodeFetch("/healthz").catch(() => ({ status: 0 }));
    if (res.status === 200) return true;
    await new Promise((done) => setTimeout(done, 200));
  }
  return false;
}

async function replayStoredTransactions(entries) {
  const pending = entries.map((entry) => entry.tx);
  const done = new Set();
  const deadline = Date.now() + 180_000;
  while (pending.some((tx) => !done.has(tx.txid))) {
    if (shuttingDown) return done.size;
    if (Date.now() > deadline) throw new Error(`timed out replaying stored transfers (${done.size} included)`);
    const confirmed = new Map();
    const balances = new Map();
    const reservedSpend = new Map();
    const batch = [];
    const queued = new Map();
    for (const tx of pending) {
      if (done.has(tx.txid)) continue;
      let base = confirmed.get(tx.sender);
      if (base === undefined) {
        const res = await nodeFetch(`/nonce/${tx.sender}`);
        if (res.status !== 200) throw new Error("nonce unavailable during restore");
        base = res.body.nonce;
        confirmed.set(tx.sender, base);
      }
      if (tx.nonce <= base) { done.add(tx.txid); continue; }
      const tip = queued.get(tx.sender) ?? base;
      if (tx.nonce !== tip + 1 || tx.nonce > base + 64) continue;
      // A received drip is not spendable until the block that included it is
      // confirmed. Submitting the spend in the same batch is rejected.
      const cost = Number(tx.amountAtoms) + Number(tx.feeAtoms);
      if (!Number.isSafeInteger(cost) || cost < 0) throw new Error("restore transfer has an invalid amount");
      let balance = balances.get(tx.sender);
      if (balance === undefined) {
        const res = await nodeFetch(`/balance/${tx.sender}`);
        if (res.status !== 200 || !Number.isSafeInteger(res.body?.balanceAtoms)) throw new Error("balance unavailable during restore");
        balance = res.body.balanceAtoms;
        balances.set(tx.sender, balance);
      }
      const reserved = reservedSpend.get(tx.sender) ?? 0;
      if (reserved + cost > balance) continue;
      batch.push(tx);
      queued.set(tx.sender, tx.nonce);
      reservedSpend.set(tx.sender, reserved + cost);
    }
    if (batch.length === 0) {
      await new Promise((doneWait) => setTimeout(doneWait, 1_000));
      continue;
    }
    for (const tx of batch) {
      const res = await nodeFetch("/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
      const message = String(res.body?.error ?? "");
      if ((res.status < 200 || res.status > 299) && !/already in mempool/i.test(message)) {
        throw new Error(`restore submit failed: ${message || res.status}`);
      }
    }
    const batchDeadline = Date.now() + 90_000;
    const waiting = new Set(batch.map((tx) => tx.txid));
    while (waiting.size && Date.now() < batchDeadline) {
      if (shuttingDown) return done.size;
      for (const tx of batch) {
        if (!waiting.has(tx.txid)) continue;
        const res = await nodeFetch(`/nonce/${tx.sender}`);
        if (res.status === 200 && res.body.nonce >= tx.nonce) waiting.delete(tx.txid);
      }
      if (waiting.size) await new Promise((doneWait) => setTimeout(doneWait, 1_000));
    }
    if (waiting.size) throw new Error(`restore inclusion timed out for ${waiting.size} transfers`);
    for (const tx of batch) done.add(tx.txid);
    await scheduleScan();
  }
  return done.size;
}

async function beginDurableMaintenance() {
  const ready = await waitForNodeReady();
  if (!ready || shuttingDown) {
    if (restoreMode === "replay") console.warn("wallet testnet validator did not become ready; stored transfers were not replayed");
    restoreReady = true;
    statusCache = undefined;
    return;
  }
  scanTimer = setInterval(() => { void scheduleScan(); }, 1_000);
  scanTimer.unref?.();
  try {
    if (restoreMode === "replay" && restoreEntries.length > 0) {
      const included = await replayStoredTransactions(restoreEntries);
      restoredTxCount = included;
      restoredAccounts = included === restoreEntries.length ? plannedRestore.restoredAccounts : 0;
      if (included !== restoreEntries.length) console.warn(`wallet testnet replay included ${included} of ${restoreEntries.length} stored transfers`);
    }
  } catch (error) {
    console.warn(`wallet testnet replay failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    restoreReady = true;
    statusCache = undefined;
  }
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down wallet testnet: ${reason}`);
  if (scanTimer) clearInterval(scanTimer);
  await scanIncludedTransactions(true).catch(() => undefined);
  await new Promise((done) => gateway.close(() => done()));
  if (child && child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((done) => setTimeout(done, 8_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (durable) await durable.close().catch(() => undefined);
  if (!explicitRoot) await rm(root, { recursive: true, force: true });
  process.exit(exitCode);
}

startValidator();
await new Promise((done, reject) => { gateway.once("error", reject); gateway.listen(gatewayPort, "0.0.0.0", () => done()); });
const port = gateway.address().port;
console.log(`ZyronChain wallet TESTNET RPC on 0.0.0.0:${port}; chain ${chainId}; genesis ${genesisHash}; faucet ${faucet.address}; stable keys=${Boolean(seedSecret)}; stateDurable=${stateDurable}; restore=${restoreMode}; value-bearing=false`);
if (durable) void beginDurableMaintenance();
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

if (smokeMode) {
  try {
    await smokeTest();
  } catch (error) {
    console.error(error);
    await shutdown("smoke-failed", 1);
  }
}

async function smokeTest() {
  const base = `http://127.0.0.1:${port}`;
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, headers: r.headers, body: await r.json() }; };
  const post = async (path, body) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  async function until(label, check, timeoutMs = 150_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const value = await check().catch(() => undefined); if (value) return value; await wait(1_000); }
    throw new Error(`timed out waiting for ${label}`);
  }
  await until("health", async () => (await get("/health")).status === 200);
  const status = await get("/status");
  assert.equal(status.body.chainId, chainId);
  assert.equal(status.body.valueBearing, false);
  assert.equal(status.headers.get("access-control-allow-origin"), "*");
  if (!process.env.ZYRON_TESTNET_DATABASE_URL?.trim()) {
    assert.equal(status.body.stateDurable, false);
    assert.equal(status.body.restoredTxCount, 0);
    assert.equal(status.body.restoredAccounts, 0);
  }
  const preflight = await fetch(`${base}/tx`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal((await get("/balance/not-an-address")).status, 400);
  assert.equal((await get("/blocks")).status, 404, "node-internal endpoints must not be exposed");
  assert.equal((await post("/block", {})).status, 404, "consensus endpoints must not be exposed");
  // P1-02-M3: neither unthrottled /health nor reads beyond 600/min in
  // aggregate (several clients, each within the per-client limit) may exhaust
  // the validator's node RPC capacity for the gateway.
  let healthFlood = 0;
  await Promise.all(Array.from({ length: 32 }, async () => { while (healthFlood < 800) { healthFlood += 1; await (await fetch(`${base}/health`)).arrayBuffer(); } }));
  const readStatuses = {}; let readIndex = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (readIndex < 400) {
      const client = `198.51.100.${10 + (readIndex % 4)}`; readIndex += 1;
      const code = (await fetch(`${base}/balance/${faucet.address}`, { headers: { "x-forwarded-for": client } })).status;
      readStatuses[code] = (readStatuses[code] ?? 0) + 1;
    }
  }));
  assert.deepEqual(readStatuses, { 200: 400 }, "reads within each client's limit must not hit the validator's rate limit");

  const alice = account("smoke-alice-" + Date.now());
  const bob = account("smoke-bob-" + Date.now());
  const aliceChecksum = toChecksumAddress(alice.address);
  const bobChecksum = toChecksumAddress(bob.address);
  assert.notEqual(aliceChecksum, alice.address, "smoke address must exercise a real checksum");
  // Published vector (docs/ADDRESS_CHECKSUM.md): one flipped letter is a checksum mismatch, not a new address.
  const wrongChecksum = "ZYN09c0B2D1A486C439A87bCbA6b46A7a1A23F3897c";
  assert.throws(() => parseAddressInput(wrongChecksum), /checksum mismatch/);
  for (const path of [`/account/${wrongChecksum}`, `/balance/${wrongChecksum}`, `/nonce/${wrongChecksum}`]) {
    const rejected = await get(path);
    assert.equal(rejected.status, 400, path);
    assert.match(rejected.body.error, /checksum mismatch/, path);
  }
  const wrongFaucet = await post("/faucet", { address: wrongChecksum });
  assert.equal(wrongFaucet.status, 400);
  assert.match(wrongFaucet.body.error, /checksum mismatch/);
  // The daily faucet limit is one drip per canonical address, whatever case the client sent.
  const drip = await post("/faucet", { address: aliceChecksum });
  assert.equal(drip.status, 200, JSON.stringify(drip.body));
  assert.equal(drip.body.receiver, alice.address, "faucet response uses the canonical address");
  assert.equal((await post("/faucet", { address: alice.address })).status, 429, "lowercase form of a checksummed drip must share the address limit");
  await until("faucet drip", async () => (await get(`/account/${aliceChecksum}`)).body.balanceAtoms === FAUCET_DRIP_ATOMS);
  const viaChecksum = (await get(`/account/${aliceChecksum}`)).body;
  const viaLower = (await get(`/account/${alice.address}`)).body;
  assert.equal(viaChecksum.address, alice.address);
  assert.deepEqual(viaChecksum, viaLower, "checksummed and lowercase reads return the same canonical account");
  assert.equal((await get(`/balance/${aliceChecksum}`)).body.address, alice.address);
  assert.equal((await get(`/balance/${alice.address}`)).body.balanceAtoms, FAUCET_DRIP_ATOMS);
  const aliceNonce = (await get(`/nonce/${aliceChecksum}`)).body.nonce;
  assert.equal((await get(`/nonce/${alice.address}`)).body.address, alice.address);
  const st = (await get("/status")).body;
  const tx = createTransfer({ chainId, nonce: aliceNonce + 1, sender: alice.address, receiver: bob.address, amountAtoms: 25 * ATOMS_PER_ZYN, feeAtoms: 0, timestampMs: Date.now() }, alice.privateKey, alice.publicKey, st.transactionVersion);
  assert.equal((await post("/tx", { ...tx, chainId: "zyron-other-testnet" })).status, 400, "wrong chain must be refused");
  const rewrittenSender = await post("/tx", { ...tx, sender: aliceChecksum });
  assert.equal(rewrittenSender.status, 400, "checksummed sender must be refused, not rewritten");
  assert.match(rewrittenSender.body.error, /canonical lowercase/);
  assert.match(rewrittenSender.body.error, /signature/);
  const rewrittenReceiver = await post("/tx", { ...tx, receiver: bobChecksum });
  assert.equal(rewrittenReceiver.status, 400);
  assert.match(rewrittenReceiver.body.error, new RegExp(bob.address));
  const sent = await post("/tx", tx);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await until("transfer", async () => (await get(`/account/${bobChecksum}`)).body.balanceAtoms === 25 * ATOMS_PER_ZYN);
  assert.equal((await get(`/account/${bobChecksum}`)).body.address, bob.address);
  const after = (await get(`/account/${alice.address}`)).body;
  assert.equal(after.balanceAtoms, 75 * ATOMS_PER_ZYN);
  assert.equal(after.nonce, aliceNonce + 1);
  console.log(JSON.stringify({ status: "ok", chainId, genesisHash, height: (await get("/status")).body.height, faucetTxid: drip.body.txid, transferTxid: sent.body.txid }, null, 2));
  await shutdown("smoke-complete");
}
