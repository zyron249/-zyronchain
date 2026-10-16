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

import { ZyronChain } from "../dist/src/chain.js";
import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { createTransfer } from "../dist/src/transaction.js";
import { gatewayClientIdentity } from "../dist/src/rpc-client-identity.js";

export const DEFAULT_CHAIN_ID = "zyron-wallet-testnet-1";
const ATOMS_PER_ZYN = 100_000_000;
const FAUCET_ALLOCATION_ATOMS = 1_000_000 * ATOMS_PER_ZYN;
const VALIDATOR_ALLOCATION_ATOMS = 1 * ATOMS_PER_ZYN;
const POOL_ALLOCATION_ATOMS = 1 * ATOMS_PER_ZYN;
const FAUCET_DRIP_ATOMS = 100 * ATOMS_PER_ZYN;
const DAY_MS = 24 * 60 * 60 * 1000;
const ADDRESS_PATTERN = /^ZYN[0-9a-f]{40}$/;
const MAX_BODY_BYTES = 8 * 1024;
const NOTICE = "ZyronChain wallet TESTNET. Test ZYN has no value, cannot be bought or sold, and the network can be reset at any time. Not mainnet.";

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
// must start from a recent genesis time. Each start is therefore a new genesis
// (new genesis hash); clients should treat a genesis-hash change as a reset.
const genesisTimestampMs = Date.now() - 60_000;
assert.ok(Number.isSafeInteger(nodePort) && nodePort > 1024 && nodePort < 65535, "invalid ZYRON_TESTNET_NODE_PORT");

// ---- keys and genesis ------------------------------------------------------
// With ZYRON_TESTNET_SEED (a testnet-only secret, 32+ characters) the
// validator and faucet keys are identical across restarts. Chain history lives
// on the host's ephemeral disk, so a restart starts a fresh genesis.
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
const genesis = {
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
const validatedGenesis = new ZyronChain(genesis);
const genesisHash = validatedGenesis.genesisHash;

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
    "--validator-key", keyPath
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
async function chainStatus() {
  if (statusCache && Date.now() - statusCacheAt < 1_000) return statusCache;
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
    faucet: { address: faucet.address, dripZyn: FAUCET_DRIP_ATOMS / ATOMS_PER_ZYN, perAddressPerDay: 1 }
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
  sweep(now) { for (const [key, entry] of this.hits) if (now - entry.start >= this.windowMs) this.hits.delete(key); }
}
const limits = {
  read: new WindowLimiter(Number(process.env.ZYRON_RPC_READS_PER_MINUTE ?? 120), 60_000),
  write: new WindowLimiter(Number(process.env.ZYRON_RPC_TX_PER_MINUTE ?? 10), 60_000),
  faucetIp: new WindowLimiter(5, DAY_MS),
  faucetAddress: new WindowLimiter(1, DAY_MS),
  faucetGlobal: new WindowLimiter(200, 60 * 60 * 1000, 1)
};

// Rate-limit identity (P1-02). ZYRON_TRUST_PROXY=1 means the service runs
// behind Render's Cloudflare edge, which sets CF-Connecting-IP; the leftmost
// X-Forwarded-For entry is client-supplied text and is never used. IPv6
// clients share one bucket per /64.
function clientIp(request) {
  return gatewayClientIdentity(request.socket.remoteAddress, request.headers, { trustCloudflareConnectingIp: trustProxy });
}

// ---- faucet ----------------------------------------------------------------
let faucetQueue = Promise.resolve();
let lastFaucetNonce = 0;
let lastFaucetNonceAt = 0;
function faucetSend(receiver) {
  const run = faucetQueue.then(async () => {
    const status = await chainStatus();
    const nonceResponse = await nodeFetch(`/nonce/${faucet.address}`);
    if (nonceResponse.status !== 200) throw new Error("faucet nonce unavailable");
    const chainNonce = nonceResponse.body.nonce;
    // A dropped faucet transaction would leave a gap; resync after 3 minutes.
    if (Date.now() - lastFaucetNonceAt > 180_000) lastFaucetNonce = 0;
    const nonce = Math.max(chainNonce, lastFaucetNonce) + 1;
    const tx = createTransfer(
      { chainId, nonce, sender: faucet.address, receiver, amountAtoms: FAUCET_DRIP_ATOMS, feeAtoms: 0, timestampMs: Date.now() },
      faucet.privateKey, faucet.publicKey, status.transactionVersion
    );
    const submitted = await nodeFetch("/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
    if (submitted.status < 200 || submitted.status > 299) throw new Error(`faucet transfer rejected: ${submitted.body?.error ?? submitted.status}`);
    lastFaucetNonce = nonce;
    lastFaucetNonceAt = Date.now();
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
function addressFrom(path, prefix) {
  const value = path.slice(prefix.length);
  return ADDRESS_PATTERN.test(value) ? value : undefined;
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
    if (request.method === "GET") {
      if (path === "/health" || path === "/healthz") {
        const alive = child && child.exitCode === null && child.signalCode === null;
        let height = null;
        try { height = (await chainStatus()).height; } catch { /* starting */ }
        return sendJson(response, alive && height !== null ? 200 : 503, { ok: Boolean(alive && height !== null), network: "testnet", valueBearing: false, chainId, height });
      }
      const rate = limits.read.take(ip);
      if (!rate.allowed) return limited(response, rate);
      if (path === "/" ) {
        return sendJson(response, 200, {
          name: "ZyronChain wallet testnet RPC",
          ...(await chainStatus()),
          endpoints: ["GET /health", "GET /status", "GET /account/{address}", "GET /balance/{address}", "GET /nonce/{address}", "POST /tx", "POST /faucet {address}"]
        });
      }
      if (path === "/status" || path === "/chain") return sendJson(response, 200, await chainStatus());
      if (path === "/genesis") return sendJson(response, 200, { network: "testnet", valueBearing: false, genesisHash, genesis });
      for (const prefix of ["/balance/", "/nonce/", "/account/"]) {
        if (!path.startsWith(prefix)) continue;
        const address = addressFrom(path, prefix);
        if (!address) return sendJson(response, 400, { error: "invalid address" });
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
        const submitted = await nodeFetch("/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
        if (submitted.status < 200 || submitted.status > 299) return sendJson(response, 400, { error: String(submitted.body?.error ?? "rejected").slice(0, 300) });
        return sendJson(response, 200, { accepted: true, txid: submitted.body.txid, note: "Included in the next block (about 30 seconds)." });
      }
      if (path === "/faucet") {
        const ipRate = limits.faucetIp.take(ip);
        if (!ipRate.allowed) return limited(response, ipRate);
        const body = await readJsonBody(request);
        const address = body && typeof body === "object" ? body.address : undefined;
        if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) return sendJson(response, 400, { error: "body must be {\"address\":\"ZYN...\"}" });
        if (address === faucet.address) return sendJson(response, 400, { error: "invalid address" });
        const addressRate = limits.faucetAddress.take(address);
        if (!addressRate.allowed) return limited(response, addressRate);
        const globalRate = limits.faucetGlobal.take("global");
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

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down wallet testnet: ${reason}`);
  await new Promise((done) => gateway.close(() => done()));
  if (child && child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((done) => setTimeout(done, 8_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (!explicitRoot) await rm(root, { recursive: true, force: true });
  process.exitCode = exitCode;
}

startValidator();
await new Promise((done, reject) => { gateway.once("error", reject); gateway.listen(gatewayPort, "0.0.0.0", () => done()); });
const port = gateway.address().port;
console.log(`ZyronChain wallet TESTNET RPC on 0.0.0.0:${port}; chain ${chainId}; genesis ${genesisHash}; faucet ${faucet.address}; stable keys=${Boolean(seedSecret)}; value-bearing=false`);
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
  const preflight = await fetch(`${base}/tx`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal((await get("/balance/not-an-address")).status, 400);
  assert.equal((await get("/blocks")).status, 404, "node-internal endpoints must not be exposed");
  assert.equal((await post("/block", {})).status, 404, "consensus endpoints must not be exposed");

  const alice = account("smoke-alice-" + Date.now());
  const bob = account("smoke-bob-" + Date.now());
  const drip = await post("/faucet", { address: alice.address });
  assert.equal(drip.status, 200, JSON.stringify(drip.body));
  assert.equal((await post("/faucet", { address: alice.address })).status, 429, "second drip for one address must be refused");
  await until("faucet drip", async () => (await get(`/account/${alice.address}`)).body.balanceAtoms === FAUCET_DRIP_ATOMS);
  const aliceNonce = (await get(`/nonce/${alice.address}`)).body.nonce;
  const st = (await get("/status")).body;
  const tx = createTransfer({ chainId, nonce: aliceNonce + 1, sender: alice.address, receiver: bob.address, amountAtoms: 25 * ATOMS_PER_ZYN, feeAtoms: 0, timestampMs: Date.now() }, alice.privateKey, alice.publicKey, st.transactionVersion);
  assert.equal((await post("/tx", { ...tx, chainId: "zyron-other-testnet" })).status, 400, "wrong chain must be refused");
  const sent = await post("/tx", tx);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await until("transfer", async () => (await get(`/account/${bob.address}`)).body.balanceAtoms === 25 * ATOMS_PER_ZYN);
  const after = (await get(`/account/${alice.address}`)).body;
  assert.equal(after.balanceAtoms, 75 * ATOMS_PER_ZYN);
  assert.equal(after.nonce, aliceNonce + 1);
  console.log(JSON.stringify({ status: "ok", chainId, genesisHash, height: (await get("/status")).body.height, faucetTxid: drip.body.txid, transferTxid: sent.body.txid }, null, 2));
  await shutdown("smoke-complete");
}
