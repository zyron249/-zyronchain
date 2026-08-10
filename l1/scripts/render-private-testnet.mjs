#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ZyronChain } from "../dist/src/chain.js";
import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "../dist/src/crypto.js";

const VALIDATOR_COUNT = 4;
const DEFAULT_RPC_BASE_PORT = 9137;
const TEST_ALLOCATION_ATOMS = 100_000_000;
const GATEWAY_SUMMARY_CACHE_MS = 1_000;
const chainId = process.env.ZYRON_TESTNET_CHAIN_ID ?? "zyron-render-private-testnet-1";
const smokeMode = process.argv.includes("--smoke");
const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = join(l1Root, "dist", "src", "cli.js");
const rpcBasePort = Number(process.env.ZYRON_TESTNET_RPC_BASE_PORT ?? DEFAULT_RPC_BASE_PORT);
const gatewayPort = smokeMode ? 0 : Number(process.env.PORT ?? 10000);

if (!Number.isSafeInteger(rpcBasePort) || rpcBasePort < 1024 || rpcBasePort + VALIDATOR_COUNT >= 65535) {
  throw new Error("ZYRON_TESTNET_RPC_BASE_PORT must leave room for four loopback validator RPC ports");
}
if (!smokeMode && (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535)) {
  throw new Error("PORT must be a valid TCP port");
}

const explicitRoot = process.env.ZYRON_TESTNET_DATA_ROOT;
const root = explicitRoot
  ? resolve(explicitRoot)
  : await mkdtemp(join(tmpdir(), "zyron-render-private-testnet-"));
if (explicitRoot) await mkdir(root, { recursive: true });

const validators = [];
for (let index = 0; index < VALIDATOR_COUNT; index += 1) {
  const privateKey = generatePrivateKey();
  const publicKey = publicKeyFromPrivate(privateKey);
  validators.push({
    index,
    privateKey,
    publicKey,
    address: addressFromPublicKey(publicKey),
    rpcPort: rpcBasePort + index,
    keyPath: join(root, `validator-${index + 1}.json`),
    dataDir: join(root, `validator-${index + 1}-data`)
  });
}

const oraclePrivateKey = generatePrivateKey();
const oraclePublicKey = publicKeyFromPrivate(oraclePrivateKey);
const activityPool = addressFromPublicKey(publicKeyFromPrivate(generatePrivateKey()));
const genesis = {
  chainId,
  timestampMs: Date.now() - 60_000,
  validators: validators.map(({ publicKey, address }) => ({ publicKey, address })),
  activityOracles: [oraclePublicKey],
  activityPool,
  allocations: [
    ...validators.map(({ address }) => ({ address, amountAtoms: TEST_ALLOCATION_ATOMS })),
    { address: activityPool, amountAtoms: TEST_ALLOCATION_ATOMS }
  ]
};

const validatedGenesis = new ZyronChain(genesis);
const genesisPath = join(root, "genesis.json");
await writeFile(genesisPath, `${JSON.stringify(genesis, null, 2)}\n`, { mode: 0o644 });
for (const validator of validators) {
  await writeFile(validator.keyPath, `${JSON.stringify({
    privateKey: validator.privateKey,
    publicKey: validator.publicKey,
    address: validator.address
  }, null, 2)}\n`, { mode: 0o600 });
}

const children = [];
let shuttingDown = false;
let fatalError;

function pipeLines(stream, label, errorStream = false) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      (errorStream ? console.error : console.log)(`[${label}] ${line}`);
    }
  });
  stream.on("end", () => {
    if (buffered) (errorStream ? console.error : console.log)(`[${label}] ${buffered}`);
  });
}

function startValidator(validator) {
  const peerArgs = validators
    .filter((candidate) => candidate.index !== validator.index)
    .flatMap((candidate) => ["--peer", `http://127.0.0.1:${candidate.rpcPort}`]);
  const child = spawn(process.execPath, [
    cliPath,
    "node",
    "--genesis", genesisPath,
    "--data", validator.dataDir,
    "--host", "127.0.0.1",
    "--port", String(validator.rpcPort),
    "--validator-key", validator.keyPath,
    ...peerArgs
  ], {
    cwd: l1Root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  pipeLines(child.stdout, `validator-${validator.index + 1}`);
  pipeLines(child.stderr, `validator-${validator.index + 1}`, true);
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    fatalError = new Error(`validator-${validator.index + 1} exited unexpectedly: code=${code} signal=${signal}`);
    console.error(fatalError.message);
    void shutdown("validator-exit", 1);
  });
  children.push(child);
}

async function fetchLocal(port, path, timeoutMs = 2_000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "x-zyron-rpc-version": "1" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

async function testnetSummary() {
  const nodes = await Promise.all(validators.map(async (validator) => {
    const [status, readiness] = await Promise.all([
      fetchLocal(validator.rpcPort, "/status"),
      fetchLocal(validator.rpcPort, "/readyz")
    ]);
    return {
      validator: validator.index + 1,
      rpc: `127.0.0.1:${validator.rpcPort}`,
      processAlive: children[validator.index]?.exitCode === null && children[validator.index]?.signalCode === null,
      status: status.ok ? status.body : null,
      ready: readiness.ok,
      readiness: readiness.body
    };
  }));

  const statuses = nodes.map((node) => node.status).filter(Boolean);
  const sameGenesis = statuses.length === VALIDATOR_COUNT && new Set(statuses.map((status) => status.genesisHash)).size === 1;
  const sameHeight = statuses.length === VALIDATOR_COUNT && new Set(statuses.map((status) => status.height)).size === 1;
  const sameTip = statuses.length === VALIDATOR_COUNT && new Set(statuses.map((status) => status.tipHash)).size === 1;
  const minHeight = statuses.length ? Math.min(...statuses.map((status) => status.height)) : 0;
  const maxHeight = statuses.length ? Math.max(...statuses.map((status) => status.height)) : 0;

  return {
    network: chainId,
    mode: "ephemeral-private-testnet",
    valueBearing: false,
    publicTestnetAuthorized: false,
    mainnetAuthorized: false,
    validatorProcesses: VALIDATOR_COUNT,
    failureDomains: 1,
    persistence: explicitRoot ? "operator-provided-path" : "ephemeral-runtime-filesystem",
    genesisHash: validatedGenesis.genesisHash,
    sameGenesis,
    converged: sameHeight && sameTip,
    minHeight,
    maxHeight,
    nodes
  };
}

function publicSummary(summary) {
  return {
    ...summary,
    nodes: summary.nodes.map(({ rpc: _rpc, ...node }) => node)
  };
}

let cachedSummary;
let cachedSummaryExpiresAt = 0;
let summaryInFlight;
async function cachedPublicSummary() {
  const now = Date.now();
  if (cachedSummary && now < cachedSummaryExpiresAt) return cachedSummary;
  if (summaryInFlight) return summaryInFlight;
  summaryInFlight = testnetSummary()
    .then((summary) => {
      cachedSummary = publicSummary(summary);
      cachedSummaryExpiresAt = Date.now() + GATEWAY_SUMMARY_CACHE_MS;
      return cachedSummary;
    })
    .finally(() => { summaryInFlight = undefined; });
  return summaryInFlight;
}

function sendJson(response, statusCode, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff"
  });
  response.end(payload);
}

function safeOriginForm(rawUrl) {
  return rawUrl.startsWith("/") && !rawUrl.startsWith("//") && !rawUrl.includes("\\") && !/[\u0000-\u001f\u007f]/.test(rawUrl);
}

const gateway = createServer(async (request, response) => {
  try {
    if (request.method !== "GET") return sendJson(response, 405, { error: "read-only testnet gateway" });
    const rawUrl = request.url ?? "/";
    if (!safeOriginForm(rawUrl)) return sendJson(response, 400, { error: "invalid request target" });
    const url = new URL(rawUrl, "http://localhost");
    if (url.origin !== "http://localhost") return sendJson(response, 400, { error: "invalid request target" });
    if (url.pathname === "/healthz") {
      const alive = children.length === VALIDATOR_COUNT && children.every((child) => child.exitCode === null && child.signalCode === null);
      return sendJson(response, alive ? 200 : 503, { alive, validatorProcesses: children.length });
    }
    if (url.pathname === "/" || url.pathname === "/status" || url.pathname === "/readyz") {
      const summary = await cachedPublicSummary();
      if (url.pathname === "/readyz") {
        const readyCount = summary.nodes.filter((node) => node.ready).length;
        const ready = readyCount >= 3 && summary.sameGenesis && summary.maxHeight >= 1;
        return sendJson(response, ready ? 200 : 503, { ready, readyCount, ...summary });
      }
      return sendJson(response, 200, summary);
    }
    return sendJson(response, 404, { error: "not found" });
  } catch (error) {
    return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 8_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down Render private testnet: ${reason}`);
  await new Promise((resolveClose) => gateway.close(() => resolveClose()));
  await Promise.all(children.map(stopChild));
  if (!explicitRoot) await rm(root, { recursive: true, force: true });
  process.exitCode = exitCode;
}

for (const validator of validators) startValidator(validator);
await new Promise((resolveListen, reject) => {
  gateway.once("error", reject);
  gateway.listen(gatewayPort, "0.0.0.0", () => resolveListen());
});
const address = gateway.address();
assert.ok(address && typeof address === "object");
console.log(`ZyronChain private testnet gateway listening on 0.0.0.0:${address.port}`);
console.log(`Chain ID ${chainId}; genesis ${validatedGenesis.genesisHash}; validators ${VALIDATOR_COUNT}; value-bearing=false`);
console.log("Validator RPC is loopback-only; public gateway accepts read-only GET status endpoints only.");

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

if (smokeMode) {
  const deadline = Date.now() + 115_000;
  let latest;
  while (Date.now() < deadline && !fatalError) {
    latest = await testnetSummary();
    if (latest.converged && latest.minHeight >= 2 && latest.nodes.every((node) => node.ready)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  if (fatalError) throw fatalError;
  assert.ok(latest?.converged, `Smoke test did not converge: ${JSON.stringify(latest)}`);
  assert.ok(latest.minHeight >= 2, `Smoke test did not finalize two blocks: ${JSON.stringify(latest)}`);
  assert.ok(latest.nodes.every((node) => node.ready), `Smoke test had unready validators: ${JSON.stringify(latest)}`);

  const localBase = `http://127.0.0.1:${address.port}`;
  const statusResponse = await fetch(`${localBase}/status`);
  assert.equal(statusResponse.status, 200, "public status gateway should be available in smoke mode");
  const statusText = await statusResponse.text();
  assert.equal(statusText.includes("127.0.0.1:"), false, "public status must not disclose loopback validator RPC addresses");
  const confusedTarget = await fetch(`${localBase}//status`, { redirect: "manual" });
  assert.equal(confusedTarget.status, 400, "double-slash request target must fail closed");
  const burst = await Promise.all(Array.from({ length: 24 }, () => fetch(`${localBase}/status`)));
  assert.equal(burst.filter((response) => response.status !== 200).length, 0, "coalesced status burst must remain available");
  await Promise.all(burst.map((response) => response.body?.cancel().catch(() => undefined)));

  console.log(JSON.stringify({
    status: "ok",
    mode: latest.mode,
    validatorProcesses: latest.validatorProcesses,
    failureDomains: latest.failureDomains,
    genesisHash: latest.genesisHash,
    finalizedHeight: latest.minHeight,
    converged: latest.converged,
    publicTestnetAuthorized: latest.publicTestnetAuthorized,
    mainnetAuthorized: latest.mainnetAuthorized,
    valueBearing: latest.valueBearing,
    gatewayHardening: {
      internalRpcHidden: true,
      doubleSlashRejected: true,
      coalescedBurstRequests: 24
    }
  }, null, 2));
  await shutdown("smoke-complete");
}
