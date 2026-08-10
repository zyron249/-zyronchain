#!/usr/bin/env node
import assert from "node:assert/strict";
import tls from "node:tls";

const target = process.env.ZYRON_LIVE_TESTNET_URL;
if (!target || !/^https:\/\/[a-z0-9.-]+$/i.test(target)) throw new Error("ZYRON_LIVE_TESTNET_URL must be an https origin");
const origin = new URL(target);
const host = origin.hostname;

async function request(path, init = {}, timeoutMs = 10_000) {
  const response = await fetch(`${target}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, text, body };
}

async function waitForProgress(genesisHash, startHeight, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await request("/status", {}, 6_000);
      if (latest.status === 200) {
        assert.equal(latest.body?.genesisHash, genesisHash, "Genesis changed during live security probe");
        if (Number(latest.body?.minHeight) >= startHeight + 2 && latest.body?.nodes?.every((node) => node.processAlive)) return latest;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`Chain did not advance two heights after live probe: ${JSON.stringify(latest?.body)}`);
}

function slowTlsHeader() {
  return new Promise((resolveSocket) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true });
    let done = false;
    let interval;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (interval) clearInterval(interval);
      clearTimeout(deadline);
      socket.destroy();
      resolveSocket(result);
    };
    socket.once("secureConnect", () => {
      socket.write(`GET /status HTTP/1.1\r\nHost: ${host}\r\nX-Slow: `);
      interval = setInterval(() => {
        if (!socket.destroyed) socket.write("a");
      }, 1_000);
      interval.unref();
    });
    socket.once("close", () => finish({ closed: true }));
    socket.once("end", () => finish({ closed: true }));
    socket.once("error", (error) => finish({ closed: true, error: error.code ?? error.message }));
    const deadline = setTimeout(() => finish({ closed: false }), 12_000);
  });
}

const baseline = await request("/status");
assert.equal(baseline.status, 200);
assert.equal(baseline.body?.valueBearing, false);
assert.equal(baseline.body?.publicTestnetAuthorized, false);
assert.equal(baseline.body?.mainnetAuthorized, false);
assert.equal(baseline.text.includes("127.0.0.1:"), false);
assert.ok(Number.isSafeInteger(baseline.body?.minHeight));
const genesisHash = baseline.body.genesisHash;
const startHeight = baseline.body.minHeight;

const slowResults = await Promise.all(Array.from({ length: 32 }, () => slowTlsHeader()));
const closedSlow = slowResults.filter((result) => result.closed).length;
assert.equal(closedSlow, slowResults.length, `Slow TLS/header connections remained open past bounded probe window: ${JSON.stringify(slowResults)}`);

const oversized = await request("/status", { headers: { "x-zyron-probe-pad": "a".repeat(20 * 1024) } });
assert.ok([400, 413, 431].includes(oversized.status), `Oversized header unexpectedly accepted: HTTP ${oversized.status}`);

for (const method of ["POST", "PUT", "DELETE"]) {
  const result = await request("/status", { method, headers: { "content-type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
  assert.equal(result.status, 405, `${method} unexpectedly accepted`);
}

const counts = { http200: 0, http503: 0, unexpected: 0 };
for (let wave = 0; wave < 8; wave += 1) {
  const results = await Promise.all(Array.from({ length: 32 }, async (_, index) => {
    try { return await request(index % 2 ? "/readyz" : "/status", {}, 10_000); }
    catch (error) { return { status: 0, error: error instanceof Error ? error.message : String(error) }; }
  }));
  for (const result of results) {
    if (result.status === 200) counts.http200 += 1;
    else if (result.status === 503) counts.http503 += 1;
    else counts.unexpected += 1;
  }
}
assert.equal(counts.unexpected, 0, `Unexpected burst results: ${JSON.stringify(counts)}`);

const health = await request("/healthz");
assert.equal(health.status, 200);
assert.equal(health.body?.alive, true);

const after = await waitForProgress(genesisHash, startHeight);
assert.equal(after.text.includes("127.0.0.1:"), false);
assert.equal(after.body?.publicTestnetAuthorized, false);
assert.equal(after.body?.mainnetAuthorized, false);
assert.equal(after.body?.valueBearing, false);

console.log(JSON.stringify({
  status: "passed",
  target,
  genesisHash,
  startHeight,
  finalMinHeight: after.body.minHeight,
  finalMaxHeight: after.body.maxHeight,
  slowTlsHeaderConnections: slowResults.length,
  slowConnectionsClosedWithinMs: 12_000,
  oversizedHeaderStatus: oversized.status,
  externalBurstRequests: 256,
  ...counts,
  validatorsAlive: after.body.nodes.every((node) => node.processAlive),
  internalRpcHidden: true,
  publicTestnetAuthorized: false,
  mainnetAuthorized: false,
  valueBearing: false
}, null, 2));
