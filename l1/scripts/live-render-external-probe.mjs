#!/usr/bin/env node
import assert from "node:assert/strict";

const target = process.env.ZYRON_LIVE_TESTNET_URL;
if (!target || !/^https:\/\/[a-z0-9.-]+$/i.test(target)) {
  throw new Error("ZYRON_LIVE_TESTNET_URL must be an https origin without a path");
}

async function request(path, init = {}, timeoutMs = 8_000) {
  const response = await fetch(`${target}${path}`, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, text, body };
}

async function waitForProgress(genesisHash, startHeight, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await request("/status", {}, 5_000);
      if (latest.status === 200) {
        assert.equal(latest.body?.genesisHash, genesisHash, "Live genesis changed during external probe");
        if (Number(latest.body?.minHeight) >= startHeight + 2) return latest;
      }
    } catch {
      // A transient edge miss is tolerated while waiting; final state must recover.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`Live chain did not advance two heights after probe: ${JSON.stringify(latest?.body)}`);
}

const baseline = await request("/status");
assert.equal(baseline.status, 200, `Baseline /status failed: HTTP ${baseline.status}`);
assert.equal(baseline.body?.valueBearing, false);
assert.equal(baseline.body?.publicTestnetAuthorized, false);
assert.equal(baseline.body?.mainnetAuthorized, false);
assert.equal(typeof baseline.body?.genesisHash, "string");
assert.ok(Number.isSafeInteger(baseline.body?.minHeight));
assert.equal(baseline.text.includes("127.0.0.1:"), false, "Public response leaked loopback validator RPC");
assert.equal(/privateKey|seed phrase|validator-key|peer-token/i.test(baseline.text), false, "Public response leaked sensitive-key vocabulary");

const baselineGenesis = baseline.body.genesisHash;
const baselineHeight = baseline.body.minHeight;

const readOnlyChecks = await Promise.all([
  request("/status", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(64 * 1024) }),
  request("/readyz", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }),
  request("/status", { method: "DELETE" })
]);
for (const result of readOnlyChecks) assert.equal(result.status, 405, `Write/method confusion was not rejected: HTTP ${result.status}`);

const unsafeTarget = await request("//status");
assert.equal(unsafeTarget.status, 400, `Double-slash request target was not rejected: HTTP ${unsafeTarget.status}`);

for (const path of ["/.env", "/.git/config", "/proc/self/environ", "/%2e%2e/%2e%2e/etc/passwd"]) {
  const result = await request(path);
  assert.ok(result.status === 400 || result.status === 404, `Unexpected file/traversal exposure for ${path}: HTTP ${result.status}`);
}

const spoofed = await request("/status", {
  headers: {
    "x-forwarded-host": "attacker.invalid",
    "x-forwarded-proto": "http",
    "x-forwarded-for": "127.0.0.1",
    "forwarded": "for=127.0.0.1;host=attacker.invalid;proto=http"
  }
});
assert.equal(spoofed.status, 200, `Proxy-header spoof changed gateway behavior: HTTP ${spoofed.status}`);
assert.equal(spoofed.body?.genesisHash, baselineGenesis);

const counts = { http200: 0, http503: 0, unexpected: 0 };
const concurrency = 32;
const waves = 8;
for (let wave = 0; wave < waves; wave += 1) {
  const results = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
    try {
      return await request(index % 2 === 0 ? "/status" : "/readyz", {}, 10_000);
    } catch (error) {
      return { status: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  for (const result of results) {
    if (result.status === 200) counts.http200 += 1;
    else if (result.status === 503) counts.http503 += 1;
    else counts.unexpected += 1;
  }
}
assert.equal(counts.unexpected, 0, `Unexpected responses during external burst: ${JSON.stringify(counts)}`);
assert.equal(counts.http200 + counts.http503, concurrency * waves);

const health = await request("/healthz");
assert.equal(health.status, 200, `Health failed after external burst: HTTP ${health.status}`);
assert.equal(health.body?.alive, true);

const after = await waitForProgress(baselineGenesis, baselineHeight);
assert.equal(after.body?.genesisHash, baselineGenesis);
assert.equal(after.text.includes("127.0.0.1:"), false);
assert.equal(after.body?.nodes?.every((node) => node.processAlive), true, "A validator process died during external probe");

console.log(JSON.stringify({
  status: "passed",
  target,
  baselineGenesis,
  baselineHeight,
  finalMinHeight: after.body.minHeight,
  finalMaxHeight: after.body.maxHeight,
  externalBurstRequests: concurrency * waves,
  ...counts,
  writeMethodsRejected: readOnlyChecks.length,
  unsafeRequestTargetRejected: true,
  internalRpcHidden: true,
  proxySpoofDidNotBypass: true,
  validatorsAlive: true,
  genesisStable: true,
  publicTestnetAuthorized: after.body.publicTestnetAuthorized,
  mainnetAuthorized: after.body.mainnetAuthorized,
  valueBearing: after.body.valueBearing
}, null, 2));
