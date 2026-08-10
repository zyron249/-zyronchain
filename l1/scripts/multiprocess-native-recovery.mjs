import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ZyronChain } from "../dist/src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";

const l1Root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(l1Root, "dist", "src", "cli.js");
const validatorOnePrivate = "01".padStart(64, "0");
const validatorTwoPrivate = "02".padStart(64, "0");
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const oraclePublic = publicKeyFromPrivate("03".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("04".padStart(64, "0")));
const alice = addressFromPublicKey(publicKeyFromPrivate("05".padStart(64, "0")));

const genesis = {
  chainId: "zyron-multiprocess-native-recovery",
  timestampMs: Date.now() - 60_000,
  validators: [
    { address: addressFromPublicKey(validatorOnePublic), publicKey: validatorOnePublic },
    { address: addressFromPublicKey(validatorTwoPublic), publicKey: validatorTwoPublic }
  ],
  activityOracles: [oraclePublic],
  activityPool,
  allocations: [
    { address: activityPool, amountAtoms: 1_000_000 },
    { address: alice, amountAtoms: 10_000 }
  ]
};

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function startNode(label, args) {
  const child = spawn(process.execPath, [cliPath, "node", ...args], {
    cwd: l1Root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const append = (chunk) => { output += chunk.toString("utf8"); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return {
    label,
    child,
    output: () => output,
    waitFor(pattern, timeoutMs = 20_000) {
      return new Promise((resolveMatch, reject) => {
        const existing = output.match(pattern);
        if (existing) return resolveMatch(existing);
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`${label} did not emit ${pattern} before timeout\n${output}`));
        }, timeoutMs);
        const check = () => {
          const match = output.match(pattern);
          if (!match) return;
          cleanup();
          resolveMatch(match);
        };
        const exited = (code, signal) => {
          cleanup();
          reject(new Error(`${label} exited before ${pattern}: code=${code} signal=${signal}\n${output}`));
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off("data", check);
          child.stderr.off("data", check);
          child.off("exit", exited);
        };
        child.stdout.on("data", check);
        child.stderr.on("data", check);
        child.once("exit", exited);
      });
    }
  };
}

async function stopNode(processInfo, signal = "SIGTERM") {
  if (!processInfo || processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) return;
  const exit = new Promise((resolveExit) => processInfo.child.once("exit", (code, exitSignal) => resolveExit({ code, exitSignal })));
  processInfo.child.kill(signal);
  const result = await Promise.race([
    exit,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${processInfo.label} did not exit after ${signal}`)), 10_000))
  ]);
  if (signal === "SIGTERM") {
    assert.match(processInfo.output(), /ZyronChain node shutdown complete/);
    assert.equal(result.code, 0, `${processInfo.label} graceful shutdown returned a nonzero code`);
  }
}

async function fetchJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.text();
  assert.equal(response.ok, true, `${path} returned HTTP ${response.status}: ${body}`);
  return JSON.parse(body);
}

async function waitForHeight(port, expected, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fetchJson(port, "/status");
      if (last.height === expected) return last;
    } catch {
      // A process may still be starting or reconnecting after SIGKILL.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Node on port ${port} did not reach height ${expected}; last status=${JSON.stringify(last)}`);
}

async function postFinalizedBlock(port, block) {
  const response = await fetch(`http://127.0.0.1:${port}/block`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zyron-rpc-version": "1"
    },
    body: JSON.stringify(block),
    signal: AbortSignal.timeout(5_000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Finalized block ${block.header.height} rejected: HTTP ${response.status} ${body}`);
}

async function postMalformedBlock(port) {
  const response = await fetch(`http://127.0.0.1:${port}/block`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zyron-rpc-version": "1"
    },
    body: '{"truncated":',
    signal: AbortSignal.timeout(5_000)
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}

function finalizedBlock(chain, height) {
  const timestampMs = genesis.timestampMs + (height * 100);
  const proposerKey = height % 2 === 1 ? validatorOnePrivate : validatorTwoPrivate;
  let block = chain.produceBlock([], proposerKey, { timestampMs });
  block = chain.attestBlock(block, validatorOnePrivate);
  block = chain.attestBlock(block, validatorTwoPrivate);
  chain.acceptBlock(block, timestampMs);
  return block;
}

const root = await mkdtemp(join(tmpdir(), "zyron-multiprocess-native-"));
const genesisPath = join(root, "genesis.json");
const seedDir = join(root, "seed");
const replicaADir = join(root, "replica-a");
const replicaBDir = join(root, "replica-b");
const processes = [];

try {
  await writeFile(genesisPath, `${JSON.stringify(genesis, null, 2)}\n`, { mode: 0o644 });
  const [seedRpc, replicaARpc, replicaBRpc] = await Promise.all([freePort(), freePort(), freePort()]);

  const seed = startNode("seed", [
    "--genesis", genesisPath,
    "--data", seedDir,
    "--host", "127.0.0.1",
    "--port", String(seedRpc),
    "--p2p-listen", "/ip4/127.0.0.1/tcp/0"
  ]);
  processes.push(seed);
  await seed.waitFor(/node listening on http:\/\/127\.0\.0\.1:\d+/);
  const nativeMatch = await seed.waitFor(/Native P2P (\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\/[A-Za-z0-9]+)/);
  const seedNative = nativeMatch[1];
  assert.ok(seedNative);

  const canonical = new ZyronChain(genesis);
  const history = [];
  for (let height = 1; height <= 10; height += 1) {
    const block = finalizedBlock(canonical, height);
    history.push(block);
    await postFinalizedBlock(seedRpc, block);
  }
  const seedAt10 = await waitForHeight(seedRpc, 10);
  assert.equal(seedAt10.tipHash, canonical.tip.hash);

  const malformed = await postMalformedBlock(seedRpc);
  assert.equal(malformed.ok, false, "Malformed consensus JSON unexpectedly succeeded");
  assert.equal((await fetchJson(seedRpc, "/status")).height, 10, "Malformed RPC changed finalized height");

  const replicaA = startNode("replica-a", [
    "--genesis", genesisPath,
    "--data", replicaADir,
    "--host", "127.0.0.1",
    "--port", String(replicaARpc),
    "--p2p-listen", "/ip4/127.0.0.1/tcp/0",
    "--p2p-peer", seedNative
  ]);
  const replicaB = startNode("replica-b", [
    "--genesis", genesisPath,
    "--data", replicaBDir,
    "--host", "127.0.0.1",
    "--port", String(replicaBRpc),
    "--p2p-listen", "/ip4/127.0.0.1/tcp/0",
    "--p2p-peer", seedNative
  ]);
  processes.push(replicaA, replicaB);

  await Promise.all([
    replicaA.waitFor(/node listening on http:\/\/127\.0\.0\.1:\d+/),
    replicaB.waitFor(/node listening on http:\/\/127\.0\.0\.1:\d+/)
  ]);
  const [a10, b10] = await Promise.all([waitForHeight(replicaARpc, 10), waitForHeight(replicaBRpc, 10)]);
  assert.equal(a10.tipHash, canonical.tip.hash);
  assert.equal(b10.tipHash, canonical.tip.hash);

  const replicaBExit = new Promise((resolveExit) => replicaB.child.once("exit", (code, signal) => resolveExit({ code, signal })));
  replicaB.child.kill("SIGKILL");
  const killed = await replicaBExit;
  assert.equal(killed.signal, "SIGKILL", "Replica B was not terminated by the hard-crash signal");

  for (let height = 11; height <= 20; height += 1) {
    const block = finalizedBlock(canonical, height);
    history.push(block);
    await postFinalizedBlock(seedRpc, block);
  }
  const seedAt20 = await waitForHeight(seedRpc, 20);
  assert.equal(seedAt20.tipHash, canonical.tip.hash);

  const a20 = await waitForHeight(replicaARpc, 20);
  assert.equal(a20.tipHash, canonical.tip.hash, "Live replica did not converge over native P2P periodic sync");

  const replay = await fetch(`http://127.0.0.1:${seedRpc}/block`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zyron-rpc-version": "1" },
    body: JSON.stringify(history[19]),
    signal: AbortSignal.timeout(5_000)
  });
  const replayBody = await replay.text();
  assert.equal(replay.ok, false, `Finalized replay unexpectedly succeeded over RPC: ${replayBody}`);
  assert.equal((await fetchJson(seedRpc, "/status")).height, 20, "Replay changed finalized height");

  const restartedB = startNode("replica-b-restarted", [
    "--genesis", genesisPath,
    "--data", replicaBDir,
    "--host", "127.0.0.1",
    "--port", String(replicaBRpc),
    "--p2p-listen", "/ip4/127.0.0.1/tcp/0",
    "--p2p-peer", seedNative
  ]);
  processes.push(restartedB);
  await restartedB.waitFor(/node listening on http:\/\/127\.0\.0\.1:\d+/);
  const b20 = await waitForHeight(replicaBRpc, 20);
  assert.equal(b20.tipHash, canonical.tip.hash, "Hard-crashed replica did not catch up to the exact finalized tip");

  const finalStatuses = await Promise.all([
    fetchJson(seedRpc, "/status"),
    fetchJson(replicaARpc, "/status"),
    fetchJson(replicaBRpc, "/status")
  ]);
  for (const status of finalStatuses) {
    assert.equal(status.height, 20);
    assert.equal(status.tipHash, canonical.tip.hash);
    assert.equal(status.chainId, genesis.chainId);
  }

  await stopNode(restartedB);
  await stopNode(replicaA);
  await stopNode(seed);

  console.log(JSON.stringify({
    status: "ok",
    processCount: 3,
    transport: "native-libp2p-noise-yamux",
    hardCrash: "SIGKILL",
    preCrashHeight: 10,
    finalHeight: 20,
    finalTipHash: canonical.tip.hash,
    malformedRpcRejected: true,
    finalizedReplayRejected: true,
    recoveredReplicaTipMatches: true
  }, null, 2));
} finally {
  for (const processInfo of processes) {
    if (processInfo.child.exitCode === null && processInfo.child.signalCode === null) {
      processInfo.child.kill("SIGKILL");
    }
  }
  await rm(root, { recursive: true, force: true });
}
