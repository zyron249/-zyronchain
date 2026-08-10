#!/usr/bin/env node
import assert from "node:assert/strict";
import net from "node:net";

const target = process.env.ZYRON_LIVE_TESTNET_URL;
if (!target || !/^https:\/\/[a-z0-9.-]+$/i.test(target)) {
  throw new Error("ZYRON_LIVE_TESTNET_URL must be an https origin without a path");
}
const host = new URL(target).hostname;

async function request(path, init = {}, timeoutMs = 8_000) {
  try {
    const response = await fetch(`${target}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { kind: "response", status: response.status, text, body, headers: Object.fromEntries(response.headers) };
  } catch (error) {
    return { kind: "network-reject", status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function portReachable(port, timeoutMs = 2_500) {
  return await new Promise((resolvePort) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reachable, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePort({ port, reachable, detail });
    };
    socket.once("connect", () => finish(true, "connected"));
    socket.once("error", (error) => finish(false, error.code ?? error.message));
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
  });
}

const baseline = await request("/status");
assert.equal(baseline.kind, "response");
assert.equal(baseline.status, 200);
assert.equal(baseline.body?.valueBearing, false);
assert.equal(baseline.body?.publicTestnetAuthorized, false);
assert.equal(baseline.body?.mainnetAuthorized, false);
const genesisHash = baseline.body.genesisHash;
const startHeight = baseline.body.minHeight;

const portChecks = [];
for (const port of [9137, 9138, 9139, 9140]) portChecks.push(await portReachable(port));
assert.equal(portChecks.some((entry) => entry.reachable), false, `Validator RPC port exposed externally: ${JSON.stringify(portChecks)}`);

const oversizedHeader = await request("/status", { headers: { "x-zyron-probe-pad": "a".repeat(20 * 1024) } });
if (oversizedHeader.kind === "response") {
  assert.ok([400, 413, 431].includes(oversizedHeader.status), `Oversized header unexpectedly accepted: HTTP ${oversizedHeader.status}`);
}

const oversizedPath = await request(`/${"a".repeat(20 * 1024)}`);
if (oversizedPath.kind === "response") {
  assert.ok([400, 404, 414, 431].includes(oversizedPath.status), `Oversized request target unexpectedly accepted: HTTP ${oversizedPath.status}`);
}

const encodedBypassPaths = [
  "/%2fstatus",
  "/%2F%2Fstatus",
  "/%5cstatus",
  "/..%2fstatus",
  "/%2e%2e%2fstatus",
  "/%00status"
];
const encodedResults = [];
for (const path of encodedBypassPaths) {
  const result = await request(path);
  encodedResults.push({ path, kind: result.kind, status: result.status });
  if (result.kind === "response") {
    assert.ok([400, 404].includes(result.status), `Encoded route bypass for ${path}: HTTP ${result.status}`);
  }
}

const trace = await request("/status", { method: "TRACE" });
if (trace.kind === "response") assert.ok([400, 405, 501].includes(trace.status), `TRACE unexpectedly accepted: HTTP ${trace.status}`);

const queryBurst = await Promise.all(Array.from({ length: 32 }, (_, index) => request(`/status?probe=${index}&pad=${"q".repeat(8 * 1024)}`, {}, 10_000)));
const queryUnexpected = queryBurst.filter((result) => result.kind !== "response" || ![200, 400, 414, 431, 503].includes(result.status));
assert.equal(queryUnexpected.length, 0, `Unexpected large-query responses: ${JSON.stringify(queryUnexpected.slice(0, 3))}`);

const after = await request("/status");
assert.equal(after.kind, "response");
assert.equal(after.status, 200);
assert.equal(after.body?.genesisHash, genesisHash, "Genesis changed during surface probe");
assert.equal(after.body?.nodes?.every((node) => node.processAlive), true, "Validator process died during surface probe");
assert.equal(after.text.includes("127.0.0.1:"), false, "Loopback RPC leaked after surface probe");

console.log(JSON.stringify({
  status: "passed",
  target,
  genesisHash,
  startHeight,
  finalMinHeight: after.body.minHeight,
  validatorPorts: portChecks,
  oversizedHeader: { kind: oversizedHeader.kind, status: oversizedHeader.status },
  oversizedPath: { kind: oversizedPath.kind, status: oversizedPath.status },
  encodedResults,
  trace: { kind: trace.kind, status: trace.status },
  largeQueryRequests: queryBurst.length,
  validatorsAlive: true,
  internalRpcHidden: true,
  publicTestnetAuthorized: after.body.publicTestnetAuthorized,
  mainnetAuthorized: after.body.mainnetAuthorized,
  valueBearing: after.body.valueBearing
}, null, 2));
