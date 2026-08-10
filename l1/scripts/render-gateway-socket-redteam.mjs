#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect, createServer as createNetServer } from "node:net";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const launcher = resolve(repoRoot, "l1/scripts/render-private-testnet.mjs");

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function fetchJson(url, timeoutMs = 3_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

async function waitFor(url, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await fetchJson(url);
      if (predicate(latest)) return latest;
    } catch {
      // Startup or bounded socket pressure may transiently reject a probe.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${JSON.stringify(latest)}`);
}

function openSlowHeader(port) {
  return new Promise((resolveSocket, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write("GET /status HTTP/1.1\r\nHost: localhost\r\nX-Slow: ");
      const interval = setInterval(() => {
        if (!socket.destroyed) socket.write("a");
      }, 1_000);
      interval.unref();
      socket.once("close", () => clearInterval(interval));
      socket.once("end", () => clearInterval(interval));
      socket.once("error", () => clearInterval(interval));
      resolveSocket(socket);
    });
  });
}

function waitForSocketClose(socket, timeoutMs) {
  return new Promise((resolveClosed, reject) => {
    if (socket.destroyed) return resolveClosed();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Slow-header socket outlived absolute header deadline"));
    }, timeoutMs);
    const closed = () => { cleanup(); resolveClosed(); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("close", closed);
      socket.off("end", closed);
      socket.off("error", closed);
    };
    socket.once("close", closed);
    socket.once("end", closed);
    socket.once("error", closed);
  });
}

function oversizedHeaderRequest(port) {
  return new Promise((resolveResult, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.once("error", (error) => data ? resolveResult(data) : reject(error));
    socket.on("data", (chunk) => { data += chunk; });
    socket.once("close", () => resolveResult(data));
    socket.once("connect", () => {
      socket.end(`GET /status HTTP/1.1\r\nHost: localhost\r\nX-Large: ${"a".repeat(20_000)}\r\n\r\n`);
    });
  });
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [launcher], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(port), ZYRON_TESTNET_CHAIN_ID: `zyron-socket-redteam-${process.pid}` },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });

async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 10_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

try {
  await waitFor(`${baseUrl}/healthz`, (result) => result.status === 200 && result.body?.alive === true, 30_000);
  const before = await waitFor(`${baseUrl}/status`, (result) => result.status === 200 && result.body?.minHeight >= 1, 90_000);
  const startHeight = before.body.minHeight;
  assert.match(output, /Gateway socket budgets: maxConnections=256, maxActiveRequests=64, maxHeaders=64, maxRequestsPerSocket=100, headerDeadlineMs=5000, headersTimeoutMs=5000, requestTimeoutMs=10000, keepAliveTimeoutMs=5000, maxHeaderBytes=16384/);

  const slowSockets = await Promise.all(Array.from({ length: 48 }, () => openSlowHeader(port)));
  await Promise.all(slowSockets.map((socket) => waitForSocketClose(socket, 7_000)));

  const oversized = await oversizedHeaderRequest(port);
  assert.match(oversized, /HTTP\/1\.1 431 /, `Oversized header was not rejected with 431: ${oversized.slice(0, 200)}`);

  const health = await fetchJson(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.body?.alive, true);

  const recovered = await waitFor(
    `${baseUrl}/status`,
    (result) => result.status === 200 && result.body?.minHeight >= startHeight + 1 && result.body?.nodes?.every((node) => node.processAlive),
    90_000
  );
  assert.equal(recovered.body.publicTestnetAuthorized, false);
  assert.equal(recovered.body.mainnetAuthorized, false);
  assert.equal(recovered.body.valueBearing, false);

  console.log(JSON.stringify({
    status: "ok",
    scenario: "render-gateway-absolute-slow-header-bounds",
    slowHeaderSockets: slowSockets.length,
    trickleIntervalMs: 1_000,
    absoluteHeaderDeadlineMs: 5_000,
    slowHeadersClosedWithinMs: 7_000,
    oversizedHeaderRejected431: true,
    startHeight,
    finalMinHeight: recovered.body.minHeight,
    validatorsAlive: true,
    publicTestnetAuthorized: false,
    mainnetAuthorized: false,
    valueBearing: false
  }, null, 2));
} finally {
  await stop();
}
