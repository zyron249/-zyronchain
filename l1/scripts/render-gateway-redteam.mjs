#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
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

async function fetchJson(url, init = {}, timeoutMs = 6_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

async function waitFor(url, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await fetchJson(url, {}, 2_000);
      if (predicate(latest)) return latest;
    } catch {
      // Startup/recovery polling is allowed to miss transiently.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}: ${JSON.stringify(latest)}`);
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [launcher], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    ZYRON_TESTNET_CHAIN_ID: `zyron-gateway-redteam-${process.pid}`
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });

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

  const counts = { http200: 0, http503: 0, unexpected: 0 };
  const waveSize = 128;
  const waves = 8;
  for (let wave = 0; wave < waves; wave += 1) {
    const results = await Promise.all(Array.from({ length: waveSize }, async (_, index) => {
      const path = index % 2 === 0 ? "/status" : "/readyz";
      try { return await fetchJson(`${baseUrl}${path}`); }
      catch (error) { return { status: 0, error: error instanceof Error ? error.message : String(error) }; }
    }));
    for (const result of results) {
      if (result.status === 200) counts.http200 += 1;
      else if (result.status === 503) counts.http503 += 1;
      else counts.unexpected += 1;
    }
  }

  assert.equal(counts.unexpected, 0, `Unexpected gateway responses during burst: ${JSON.stringify(counts)}`);
  assert.equal(counts.http200 + counts.http503, waveSize * waves);

  const post = await fetchJson(`${baseUrl}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(post.status, 405, "Public gateway must stay read-only after burst");

  const confused = await fetch(`${baseUrl}//status`, { redirect: "manual" });
  assert.equal(confused.status, 400, "Double-slash request target must stay fail-closed");

  const health = await fetchJson(`${baseUrl}/healthz`);
  assert.equal(health.status, 200, `Gateway/validators unhealthy after burst: ${JSON.stringify(health.body)}`);

  const recovered = await waitFor(
    `${baseUrl}/status`,
    (result) => result.status === 200 && result.body?.minHeight >= startHeight + 2 && result.body?.nodes?.every((node) => node.processAlive),
    120_000
  );

  assert.equal(JSON.stringify(recovered.body).includes("127.0.0.1:"), false, "Public summary leaked loopback validator RPC");
  assert.equal(recovered.body.publicTestnetAuthorized, false);
  assert.equal(recovered.body.mainnetAuthorized, false);
  assert.equal(recovered.body.valueBearing, false);

  console.log(JSON.stringify({
    status: "ok",
    scenario: "render-gateway-large-bounded-burst",
    totalRequests: waveSize * waves,
    ...counts,
    startHeight,
    finalMinHeight: recovered.body.minHeight,
    finalMaxHeight: recovered.body.maxHeight,
    validatorsAlive: recovered.body.nodes.every((node) => node.processAlive),
    internalRpcHidden: true,
    doubleSlashRejected: true,
    publicTestnetAuthorized: recovered.body.publicTestnetAuthorized,
    mainnetAuthorized: recovered.body.mainnetAuthorized,
    valueBearing: recovered.body.valueBearing
  }, null, 2));
} catch (error) {
  console.error(`Gateway red-team rehearsal failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  console.error(`Launcher stderr tail: ${stderr.slice(-8_000)}`);
  process.exitCode = 1;
} finally {
  await stop();
}
