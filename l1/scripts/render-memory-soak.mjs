#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const launcher = resolve(repoRoot, "l1/scripts/render-private-testnet.mjs");
const warmupHeight = Number(process.env.ZYRON_MEMORY_SOAK_WARMUP_HEIGHT ?? 2);
const targetHeight = Number(process.env.ZYRON_MEMORY_SOAK_TARGET_HEIGHT ?? 6);
const sampleIntervalMs = Number(process.env.ZYRON_MEMORY_SOAK_SAMPLE_INTERVAL_MS ?? 5_000);
const maxTotalRssBytes = Number(process.env.ZYRON_MEMORY_SOAK_MAX_TOTAL_RSS_BYTES ?? 440 * 1024 * 1024);
const maxPostWarmupGrowthBytes = Number(process.env.ZYRON_MEMORY_SOAK_MAX_GROWTH_BYTES ?? 96 * 1024 * 1024);

for (const [value, label] of [
  [warmupHeight, "warmup height"],
  [targetHeight, "target height"],
  [sampleIntervalMs, "sample interval"],
  [maxTotalRssBytes, "max total RSS"],
  [maxPostWarmupGrowthBytes, "max growth"]
]) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `Invalid ${label}`);
}
assert.ok(targetHeight > warmupHeight, "Target height must exceed warmup height");
assert.ok(sampleIntervalMs >= 1_000, "Sample interval is too small");

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
  return { status: response.status, body, text };
}

async function readRssBytes(pid) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  if (!match) throw new Error(`VmRSS is unavailable for pid ${pid}`);
  return Number(match[1]) * 1024;
}

async function directChildren(pid) {
  const text = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
  return text.trim()
    ? text.trim().split(/\s+/).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)
    : [];
}

async function processMemorySnapshot(launcherPid) {
  const children = await directChildren(launcherPid);
  if (children.length !== 4) {
    throw new Error(`Expected four validator child processes, found ${children.length}: ${children.join(",")}`);
  }
  const gatewayRssBytes = await readRssBytes(launcherPid);
  const validators = [];
  for (const pid of [...children].sort((a, b) => a - b)) {
    validators.push({ pid, rssBytes: await readRssBytes(pid) });
  }
  return {
    gatewayPid: launcherPid,
    gatewayRssBytes,
    validators,
    totalRssBytes: gatewayRssBytes + validators.reduce((sum, item) => sum + item.rssBytes, 0)
  };
}

async function waitForStatus(baseUrl, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await fetchJson(`${baseUrl}/status`);
      if (latest.status === 200 && predicate(latest.body)) return latest.body;
    } catch {
      // Launcher may still be starting or replacing an internal connection.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for status condition: ${JSON.stringify(latest?.body)}`);
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [launcher], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    ZYRON_TESTNET_CHAIN_ID: `zyron-memory-soak-${process.pid}`
  },
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
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 12_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

try {
  await waitForStatus(baseUrl, (status) => status?.nodes?.length === 4, 30_000);
  const samples = [];
  let lastSampleAt = 0;
  const deadline = Date.now() + 14 * 60_000;
  let finalStatus;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Render launcher exited during memory soak: code=${child.exitCode} signal=${child.signalCode}\n${output.slice(-8_000)}`);
    }

    let status;
    try {
      const response = await fetchJson(`${baseUrl}/status`);
      if (response.status === 200) status = response.body;
    } catch {
      // A transient status miss is acceptable; process liveness is checked separately.
    }

    if (status && Date.now() - lastSampleAt >= sampleIntervalMs) {
      const memory = await processMemorySnapshot(child.pid);
      const sample = {
        timestampMs: Date.now(),
        height: status.minHeight,
        converged: status.converged,
        ...memory
      };
      samples.push(sample);
      lastSampleAt = sample.timestampMs;
      console.log(`MEMORY_SAMPLE ${JSON.stringify(sample)}`);
    }

    if (status?.minHeight >= targetHeight && status?.nodes?.every((node) => node.processAlive)) {
      finalStatus = status;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }

  assert.ok(finalStatus, `Memory soak did not reach target height ${targetHeight}`);
  assert.equal(finalStatus.converged, true, "Validators did not converge by target height");
  assert.equal(finalStatus.publicTestnetAuthorized, false);
  assert.equal(finalStatus.mainnetAuthorized, false);
  assert.equal(finalStatus.valueBearing, false);
  assert.equal(JSON.stringify(finalStatus).includes("127.0.0.1:"), false, "Public status disclosed loopback validator RPC");

  const postWarmup = samples.filter((sample) => sample.height >= warmupHeight);
  assert.ok(postWarmup.length >= 3, `Insufficient post-warmup memory samples: ${postWarmup.length}`);
  const first = postWarmup[0];
  const last = postWarmup.at(-1);
  const peak = Math.max(...postWarmup.map((sample) => sample.totalRssBytes));
  const growth = last.totalRssBytes - first.totalRssBytes;

  assert.ok(
    peak <= maxTotalRssBytes,
    `Four-validator process RSS exceeded headroom budget: peak=${peak} limit=${maxTotalRssBytes}`
  );
  assert.ok(
    growth <= maxPostWarmupGrowthBytes,
    `Post-warmup RSS growth exceeded budget: growth=${growth} limit=${maxPostWarmupGrowthBytes}`
  );

  console.log(JSON.stringify({
    status: "ok",
    scenario: "render-four-validator-memory-soak",
    warmupHeight,
    targetHeight,
    sampleCount: samples.length,
    postWarmupSampleCount: postWarmup.length,
    firstPostWarmupTotalRssBytes: first.totalRssBytes,
    finalTotalRssBytes: last.totalRssBytes,
    peakPostWarmupTotalRssBytes: peak,
    postWarmupGrowthBytes: growth,
    maxTotalRssBytes,
    maxPostWarmupGrowthBytes,
    finalHeight: finalStatus.minHeight,
    validatorsAlive: finalStatus.nodes.every((node) => node.processAlive),
    converged: finalStatus.converged,
    publicTestnetAuthorized: false,
    mainnetAuthorized: false,
    valueBearing: false,
    note: "Summed per-process RSS is a conservative process-level regression metric and may double-count shared pages."
  }, null, 2));
} finally {
  await stop();
}
