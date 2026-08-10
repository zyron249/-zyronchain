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
function expectStatus(result, allowed, id) {
  if (!allowed.includes(result.status)) finding("high", id, `unexpected HTTP ${result.status}${result.error ? ` (${result.error})` : ""}`);
}

const rootResult = await request("/");
const statusResult = await request("/status");
observations.push({
  id: "routing-baseline",
  detail: {
    rootStatus: rootResult.status,
    statusStatus: statusResult.status,
    rootContentType: rootResult.headers["content-type"] ?? null,
    statusContentType: statusResult.headers["content-type"] ?? null,
    rootBodyPrefix: rootResult.text.slice(0, 240),
    statusBodyPrefix: statusResult.text.slice(0, 240)
  }
});

let baselinePath;
let baseline;
if (statusResult.status === 200 && statusResult.body && typeof statusResult.body === "object") {
  baselinePath = "/status";
  baseline = statusResult;
} else if (rootResult.status === 200 && rootResult.body && typeof rootResult.body === "object") {
  baselinePath = "/";
  baseline = rootResult;
  finding("medium", "status-route-unavailable", `/status returned HTTP ${statusResult.status} while / remained available`);
} else {
  finding("high", "public-gateway-unreachable", `root=${rootResult.status}, status=${statusResult.status}`);
  baselinePath = "/";
  baseline = rootResult;
}

for (const [field, expected] of [
  ["valueBearing", false], ["publicTestnetAuthorized", false], ["mainnetAuthorized", false],
  ["validatorProcesses", 4], ["failureDomains", 1]
]) {
  if (baseline.body?.[field] !== expected) finding("high", `baseline-${field}`, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(baseline.body?.[field])}`);
}

const baselineHeight = Number(baseline.body?.maxHeight ?? 0);
const baselineGenesis = baseline.body?.genesisHash;
const baselineText = JSON.stringify(baseline.body);
if (/privateKey|mnemonic|seed phrase|seedPhrase|password|keystorePassword|validator-\d+\.json/i.test(baselineText)) {
  finding("critical", "secret-material-in-status", "public status response appears to expose secret/key material");
}
if (/127\.0\.0\.1:\d+/.test(baselineText)) {
  finding("low", "internal-loopback-topology-disclosure", "public status reveals internal loopback RPC addresses; no direct access was demonstrated");
}

for (const path of ["/readyz", "/healthz"]) expectStatus(await request(path), [200, 503], `baseline-${path}`);

for (const path of [
  "/.env", "/.git/config", "/package.json", "/genesis.json", "/validator-1.json", "/etc/passwd",
  "/%2e%2e/%2e%2e/etc/passwd", "/status%2f..%2f..%2fetc%2fpasswd", "//status", "/STATUS", "/metrics"
]) {
  const result = await request(path);
  if (![404, 405].includes(result.status)) finding("high", "hidden-path-exposure", `${path} returned HTTP ${result.status}`);
  if (/root:.*:0:0:|PRIVATE KEY|privateKey|PASSWORD=/i.test(result.text)) finding("critical", "sensitive-file-disclosure", `${path} returned sensitive-looking content`);
}

for (const path of ["/block", "/tx", "/proposal/attest", "/round/skip", "/validator", "/protocol"]) {
  const getResult = await request(path);
  if (![404, 405].includes(getResult.status)) finding("high", "public-consensus-read-route", `GET ${path} returned ${getResult.status}`);
  const postResult = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zyron-rpc-version": "1" },
    body: JSON.stringify({ test: true, block: { header: { height: 999999 } } })
  });
  if (postResult.status !== 405) finding("critical", "public-consensus-write-bypass", `POST ${path} returned ${postResult.status}`);
}

for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "HEAD"]) {
  const result = await request(baselinePath, { method });
  if (result.status !== 405) finding("high", "method-confusion", `${method} ${baselinePath} returned ${result.status}`);
}

const spoof = await request(baselinePath, {
  headers: {
    "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", "x-forwarded-proto": "http",
    "authorization": "Bearer definitely-not-a-real-token", "x-zyron-rpc-version": "1"
  }
});
if (spoof.status !== 200) finding("medium", "proxy-header-spoofing-availability", `spoofed status returned ${spoof.status}`);

const oversized = await request("/block", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ junk: "A".repeat(64 * 1024) })
});
if (oversized.status !== 405) finding("high", "oversized-write-body", `64KiB POST /block returned ${oversized.status}`);

const longQuery = await request(`${baselinePath}?probe=${"a".repeat(4096)}`);
if (longQuery.status !== 200) finding("medium", "long-query-availability", `4KiB query returned ${longQuery.status}`);

const burst = await Promise.all(Array.from({ length: 24 }, () => request(baselinePath)));
const burstFailures = burst.filter((result) => result.status !== 200).length;
if (burstFailures > 0) finding("medium", "small-concurrency-burst", `${burstFailures}/24 low-rate concurrent status requests failed`);
if (burst.some((result) => result.text.length > 64 * 1024)) finding("medium", "unbounded-status-response", "status response exceeded 64KiB");

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
  genesisHash: baselineGenesis ?? null,
  findings,
  observations,
  checks: {
    writeBypassAttempted: true, methodConfusionAttempted: true, traversalAndDotfilesAttempted: true,
    proxyHeaderSpoofingAttempted: true, malformedOversizedBodyAttempted: true, smallConcurrencyBurst: 24,
    secretsScannedInPublicStatus: true
  }
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (criticalOrHigh.length) process.exitCode = 1;
