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
// <secret dir> holds plaintext TEST validator/faucet keys (mode 0600) and the
// chain data. It must live outside the repository and must never be shared.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = (name) => join(l1Root, "dist/src", name);
const { ZyronChain } = await import(dist("chain.js"));
const { ChainStore } = await import(dist("storage.js"));
const { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } = await import(dist("crypto.js"));
const { createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer } = await import(dist("transaction.js"));
const { expectedValidator } = await import(dist("block.js"));
const { fixedSupplyPlanAtoms, FIXED_SUPPLY_LAUNCH_PROFILE } = await import(dist("tokenomics.js"));
const { gatewayClientIdentity } = await import(dist("rpc-client-identity.js"));

export const DEFAULT_CHAIN_ID = "zyron-open-testnet-1";
const VALIDATOR_NAMES = ["v1", "v2", "v3", "v4"];
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
// through ChainStore validation; keys must match the genesis validator set.
export async function restoreNetwork(dir, bundle, expectedChainId) {
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
  for (const name of VALIDATOR_NAMES) {
    const data = join(dir, `data-${name}`);
    await mkdir(data, { mode: 0o700 });
    const store = await ChainStore.open(genesis, data);
    for (const block of blocks) await store.commitFinalizedBlock(block);
  }
  await writeFile(join(dir, "network.json"), `${JSON.stringify(network, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  return { chainId: genesis.chainId, genesisHash: network.genesisHash, height: blocks.length };
}

// ---- init: fresh TEST keys, fixed-supply-v1 genesis, v6 prefix ----------------
export async function initNetwork(dir, chainId) {
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
  }
  assert.equal(chain.protocolVersionAt(V6_ACTIVATION_HEIGHT), 6);
  await writeFile(join(dir, "genesis.json"), `${JSON.stringify(genesis, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  for (const name of VALIDATOR_NAMES) {
    const data = join(dir, `data-${name}`);
    await mkdir(data, { mode: 0o700 });
    const store = await ChainStore.open(genesis, data);
    for (const block of blocks) await store.commitFinalizedBlock(block);
  }
  const publicInfo = {
    network: "testnet", valueBearing: false, notice: NOTICE, chainId, genesisHash: chain.genesisHash,
    launchProfile: FIXED_SUPPLY_LAUNCH_PROFILE, protocolV6ActivationHeight: V6_ACTIVATION_HEIGHT,
    validators: genesis.validators, faucetAddress: roles.faucet.address,
    roles: { founderVesting: roles.founder.address, publicDistributionFaucet: roles.faucet.address, permanentLiquidity: roles.liquidity.address, ecosystemActivityPool: roles.ecosystem.address }
  };
  await writeFile(join(dir, "network.json"), `${JSON.stringify(publicInfo, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  return publicInfo;
}

// ---- run: validators + gateway ---------------------------------------------------
export async function runNetwork(dir, { gatewayPort, basePort = 9300, host = "127.0.0.1", log = true, stateSecret, persistence = { mode: "local-disk" } } = {}) {
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
      "--host", "127.0.0.1", "--port", String(ports[index]), "--validator-key", join(dir, "keys", `${name}.json`)];
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
  let snapshotCache; let snapshotCacheAt = 0;
  async function buildSnapshot() {
    if (snapshotCache && Date.now() - snapshotCacheAt < 60_000) return snapshotCache;
    const tip = (await chainStatus()).height;
    const blocks = [];
    while (blocks.length < tip) {
      const result = await anyNode(`/blocks?from=${blocks.length + 1}&limit=100`);
      if (result.status !== 200 || !Array.isArray(result.body?.blocks) || result.body.blocks.length === 0) throw new Error("snapshot block read failed");
      for (const block of result.body.blocks) { if (block.header.height === blocks.length + 1 && blocks.length < tip) blocks.push(block); }
    }
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

  const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
  const PEER_RPC = { "x-zyron-rpc-version": "1" };
  const SECURITY = { "x-content-type-options": "nosniff", "x-zyron-network": "testnet-no-value", "referrer-policy": "no-referrer" };
  function sendJson(response, code, body, extra = {}) {
    const payload = `${JSON.stringify(body, null, 2)}\n`;
    response.writeHead(code, { ...CORS, ...SECURITY, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload), ...extra });
    response.end(payload);
  }
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

  let active = 0;
  const gateway = createServer({ headersTimeout: 5_000, requestTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16_384 }, async (request, response) => {
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
          const validators = await validatorStatuses();
          const up = validators.filter((v) => v.up);
          const heights = up.map((v) => v.height);
          const quorum = Math.floor((2 * genesis.validators.length) / 3) + 1;
          const ok = up.length >= quorum;
          return sendJson(response, ok ? 200 : 503, { ok, network: "testnet", valueBearing: false, chainId, quorum, validatorsUp: up.length, maxHeight: heights.length ? Math.max(...heights) : null, validators });
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
  });
  gateway.maxConnections = 256;

  for (const name of VALIDATOR_NAMES) startValidator(name);
  await new Promise((done, reject) => { gateway.once("error", reject); gateway.listen(gatewayPort, host, () => done()); });
  const port = gateway.address().port;
  console.log(`ZyronChain open TESTNET gateway on ${host}:${port}; chain ${chainId}; genesis ${info.genesisHash}; validators ${VALIDATOR_NAMES.length}; value-bearing=false`);
  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    await new Promise((done) => gateway.close(() => done()));
    await Promise.all(VALIDATOR_NAMES.map((name) => stopValidator(name)));
  }
  return { port, chainId, info, faucet, shutdown, stopValidator, startValidator, validatorStatuses };
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
    network = await runNetwork(join(dir, "restored"), { gatewayPort: 0, basePort: 19300 + Math.floor(Math.random() * 500) * 4, log: false, stateSecret: smokeSecret, persistence: { mode: "snapshot-restore" } });
    const base2 = `http://127.0.0.1:${network.port}`;
    await until("restored chain finalizes past the snapshot", async () => { const s = await (await fetch(`${base2}/status`)).json(); return s.genesisHash === info.genesisHash && s.height > snapHeight; }, 360_000);
    assert.equal((await (await fetch(`${base2}/account/${bob.address}`)).json()).balanceAtoms, 25 * ATOMS_PER_ZYN);
    console.log(JSON.stringify({ ok: true, snapshotHeight: snapHeight, chainId: info.chainId, genesisHash: info.genesisHash, protocolVersion: 6, faucetTxid: drip.body.txid, transferTxid: tx.txid, heightAfterRestart: rejoined }, null, 2));
  } finally {
    if (network) await network.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}

if (command === "init") {
  const dir = resolve(option("--dir"));
  const result = await initNetwork(dir, option("--chain-id", DEFAULT_CHAIN_ID));
  console.log(JSON.stringify({ chainId: result.chainId, genesisHash: result.genesisHash, faucetAddress: result.faucetAddress, directory: dir }, null, 2));
} else if (command === "run") {
  const dir = resolve(option("--dir"));
  // --init-if-missing is for hosts without a persistent disk (for example a
  // free web service): a missing directory gets a fresh TEST genesis, so every
  // cold start is a new network with a new genesis hash.
  const stateSecret = process.env.ZYRON_TESTNET_STATE_SECRET || undefined;
  let persistence = { mode: "local-disk" };
  if (rest.includes("--init-if-missing")) {
    const exists = await stat(join(dir, "network.json")).then(() => true, () => false);
    const chainId = option("--chain-id", process.env.ZYRON_TESTNET_CHAIN_ID ?? DEFAULT_CHAIN_ID);
    const restoreUrl = option("--restore-url", process.env.ZYRON_TESTNET_STATE_URL || undefined);
    if (!exists && restoreUrl && stateSecret) {
      try {
        const response = await fetch(restoreUrl, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
        if (response.status === 404) console.log("no state snapshot published yet; creating a fresh TEST genesis");
        else {
          assert.equal(response.status, 200, `snapshot download returned ${response.status}`);
          const restored = await restoreNetwork(dir, openSnapshot(Buffer.from(await response.arrayBuffer()), stateSecret), chainId);
          persistence = { mode: "snapshot-restore", restoredHeight: restored.height, restoredAtMs: Date.now() };
          console.log(`restored ${restored.chainId} genesis ${restored.genesisHash} at height ${restored.height}`);
        }
      } catch (error) {
        console.error(`STATE RESTORE FAILED (${error instanceof Error ? error.message : String(error)}); creating a fresh TEST genesis`);
        await rm(dir, { recursive: true, force: true });
      }
    }
    if (!(await stat(join(dir, "network.json")).then(() => true, () => false))) {
      console.log(JSON.stringify(await initNetwork(dir, chainId)));
      persistence = { mode: exists ? "local-disk" : "fresh-genesis", createdAtMs: Date.now() };
    }
  }
  const network = await runNetwork(dir, { stateSecret, persistence, host: option("--host", "127.0.0.1"), gatewayPort: Number(option("--port", process.env.PORT ?? "10000")), basePort: Number(option("--validator-base-port", "9300")) });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void network.shutdown().then(() => process.exit(0)); });
} else if (command === "smoke") {
  await smoke();
  process.exit(0);
} else {
  console.error("usage: open-testnet.mjs init --dir <dir> [--chain-id id] | run --dir <dir> [--port n] | smoke");
  process.exit(2);
}
