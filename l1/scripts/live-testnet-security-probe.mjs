#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const base = process.env.ZYRON_LIVE_TESTNET_URL ?? "https://zyronchain-private-testnet.onrender.com";
const output = process.env.ZYRON_LIVE_PROBE_OUTPUT ?? "live-testnet-security-probe.json";
const findings = [];
const observations = [];
let requests = 0;

async function request(path, options = {}) {
  requests += 1;
  try {
    const response = await fetch(`${base}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      ...options
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), text, body };
  } catch (error) {
    return { status: 0, ok: false, headers: {}, text: "", body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function finding(severity, id, detail) { findings.push({ severity, id, detail }); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForGateway() {
  const attempts = [];
  for (let i = 0; i < 12; i += 1) {
    for (const path of ["/status", "/"]) {
      const result = await request(path);
      attempts.push({ path, status: result.status, bodyPrefix: result.text.slice(0, 120) });
      if (result.status === 200 && result.body && typeof result.body === "object" && result.body.validatorProcesses === 4) {
        return { path, result, attempts };
      }
    }
    await sleep(1_000);
  }
  return { path: null, result: null, attempts };
}

const warm = await waitForGateway();
observations.push({ id: "gateway-warmup", detail: warm.attempts });
if (!warm.result) {
  finding("high", "public-gateway-unreachable", "gateway did not return the expected four-validator JSON status during warm-up");
}
const baselinePath = warm.path ?? "/status";
const baseline = warm.result ?? { status: 0, body: null, text: "", headers: {} };

for (const [field, expected] of [
  ["valueBearing", false], ["publicTestnetAuthorized", false], ["mainnetAuthorized", false],
  ["validatorProcesses", 4], ["failureDomains", 1]
]) {
  if (baseline.body?.[field] !== expected) finding("high", `baseline-${field}`, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(baseline.body?.[field])}`);
}

const baselineHeight = Number(baseline.body?.maxHeight ?? 0);
const baselineGenesis = baseline.body?.genesisHash ?? null;
const baselineText = JSON.stringify(baseline.body);
if (/privateKey|mnemonic|seed phrase|seedPhrase|password|keystorePassword|validator-\d+\.json/i.test(baselineText)) {
  finding("critical", "secret-material-in-status", "public status response appears to expose secret/key material");
}
if (/127\.0\.0\.1:\d+/.test(baselineText)) {
  finding("low", "internal-loopback-topology-disclosure", "public status reveals internal loopback RPC addresses; no direct access was demonstrated");
}

for (const path of ["/readyz", "/healthz"]) {
  const result = await request(path);
  if (![200, 503].includes(result.status)) finding("medium", `baseline-${path}`, `unexpected HTTP ${result.status}`);
}

for (const path of [
  "/.env", "/.git/config", "/package.json", "/genesis.json", "/validator-1.json", "/etc/passwd",
  "/%2e%2e/%2e%2e/etc/passwd", "/status%2f..%2f..%2fetc%2fpasswd", "//status", "/STATUS", "/metrics"
]) {
  const result = await request(path);
  if (![400, 404, 405].includes(result.status)) finding("high", "hidden-path-exposure", `${path} returned HTTP ${result.status}`);
  if (/root:.*:0:0:|PRIVATE KEY|privateKey|PASSWORD=/i.test(result.text)) finding("critical", "sensitive-file-disclosure", `${path} returned sensitive-looking content`);
}

for (const path of ["/block", "/tx", "/proposal/attest", "/round/skip", "/validator", "/protocol"]) {
  const getResult = await request(path);
  if (![400, 404, 405].includes(getResult.status)) finding("high", "public-consensus-read-route", `GET ${path} returned ${getResult.status}`);
  const postResult = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zyron-rpc-version": "1" },
    body: JSON.stringify({ test: true, block: { header: { height: 999999 } } })
  });
  if (![400, 404, 405].includes(postResult.status)) finding("critical", "public-consensus-write-bypass", `POST ${path} returned ${postResult.status}`);
}

for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
  const result = await request(baselinePath, { method });
  if (![400, 404, 405].includes(result.status)) finding("high", "method-confusion", `${method} ${baselinePath} returned ${result.status}`);
}
// Node's fetch client refuses TRACE before a network request; do not misclassify client-side rejection as a server finding.

const spoof = await request(baselinePath, {
  headers: {
    "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", "x-forwarded-proto": "http",
    "authorization": "Bearer definitely-not-a-real-token", "x-zyron-rpc-version": "1"
  }
});
if (spoof.status !== 200) finding("medium", "proxy-header-spoofing-availability", `spoofed status returned ${spoof.status}`);
if (spoof.status === 200 && spoof.body?.validatorProcesses !== 4) finding("high", "proxy-header-spoofing-route-change", "spoofed headers changed the public gateway representation unexpectedly");

const oversized = await request("/block", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ junk: "A".repeat(64 * 1024) })
});
if (![400, 404, 405, 413].includes(oversized.status)) finding("high", "oversized-write-body", `64KiB POST /block returned ${oversized.status}`);

const longQuery = await request(`${baselinePath}?probe=${"a".repeat(4096)}`);
if (longQuery.status !== 200) finding("medium", "long-query-availability", `4KiB query returned ${longQuery.status}`);

const burst = await Promise.all(Array.from({ length: 24 }, () => request(baselinePath)));
const burstFailures = burst.filter((result) => result.status !== 200).length;
if (burstFailures > 4) finding("medium", "small-concurrency-burst", `${burstFailures}/24 low-rate concurrent status requests failed`);
if (burst.some((result) => result.text.length > 64 * 1024)) finding("medium", "unbounded-status-response", "status response exceeded 64KiB");

await sleep(500);
const after = await request(baselinePath);
if (after.status !== 200) finding("high", "post-probe-gateway-unavailable", `post-probe ${baselinePath} returned ${after.status}`);
if (baselineGenesis && after.body?.genesisHash !== baselineGenesis) finding("critical", "genesis-changed-during-probe", "genesis changed during non-destructive probe");
if (Number(after.body?.maxHeight ?? 0) < baselineHeight) finding("critical", "height-regressed-during-probe", "finalized height regressed during probe");
if (after.body?.publicTestnetAuthorized !== false || after.body?.mainnetAuthorized !== false || after.body?.valueBearing !== false) {
  finding("critical", "safety-flags-changed", "launch/value safety flags changed during probe");
}

const criticalOrHigh = findings.filter((item) => item.severity === "critical" || item.severity === "high");
const report = {
  status: criticalOrHigh.length ? "failed" : "passed",
  target: base,
  requests,
  baselinePath,
  baselineHeight,
  finalHeight: Number(after.body?.maxHeight ?? 0),
  genesisHash: baselineGenesis,
  findings,
  observations,
  checks: {
    publicGatewayWarmup: true,
    writeBypassAttempted: true,
    methodConfusionAttempted: true,
    traversalAndDotfilesAttempted: true,
    proxyHeaderSpoofingAttempted: true,
    malformedOversizedBodyAttempted: true,
    smallConcurrencyBurst: 24,
    secretsScannedInPublicStatus: true
  }
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (criticalOrHigh.length) process.exitCode = 1;
