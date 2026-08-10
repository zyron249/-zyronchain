#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const launcherPath = resolve(l1Root, "scripts/render-private-testnet.mjs");
const pollIntervalMs = 2_000;
const readyTimeoutMs = 1_500;
const childStopTimeoutMs = 8_000;
const clockRecoveryTimeoutMs = 30_000;
const finalityRecoveryTimeoutMs = 120_000;
const wallClockSafetyMarginMs = 2_000;
const stableClockSamplesRequired = 4;
const stableClockSampleIntervalMs = 500;
const maxClockRestarts = 2;
const monitorOnly = process.argv.includes("--test-monitor-only");
const testRecoveryOnce = process.argv.includes("--test-recovery-once");
const smokeMode = process.argv.includes("--smoke");
const testUrl = process.env.ZYRON_SUPERVISOR_TEST_URL;
const gatewayPort = Number(process.env.PORT ?? 10000);

if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
  throw new Error("PORT must be a valid TCP port");
}
if (monitorOnly && (!testUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(testUrl))) {
  throw new Error("--test-monitor-only requires loopback ZYRON_SUPERVISOR_TEST_URL");
}
if (monitorOnly && testRecoveryOnce) throw new Error("Supervisor test modes are mutually exclusive");

const configuredRoot = process.env.ZYRON_TESTNET_DATA_ROOT;
const supervisorRoot = monitorOnly
  ? undefined
  : configuredRoot
    ? resolve(configuredRoot)
    : await mkdtemp(join(tmpdir(), "zyron-render-supervised-"));
if (supervisorRoot) await mkdir(supervisorRoot, { recursive: true });

let child;
let shuttingDown = false;
let childExit;
let expectedChildStop = false;
let clockRestartCount = 0;
let highestObservedWallClockMs = Date.now();
let expectedGenesisHash;
let testRecoveryTriggered = false;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function validatorClockFaults(summary) {
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.nodes)) return [];
  return summary.nodes
    .filter((node) => Array.isArray(node?.readiness?.reasons) && node.readiness.reasons.includes("validator-clock-unhealthy"))
    .map((node) => Number(node.validator))
    .filter((validator) => Number.isSafeInteger(validator) && validator >= 1);
}

async function fetchReady(url) {
  const response = await fetch(`${url}/readyz`, {
    headers: { "x-zyron-rpc-version": "1" },
    signal: AbortSignal.timeout(readyTimeoutMs)
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}

function observeWallClock() {
  const now = Date.now();
  highestObservedWallClockMs = Math.max(highestObservedWallClockMs, now);
  return now;
}

function spawnLauncher() {
  childExit = undefined;
  child = spawn(process.execPath, [launcherPath, ...(smokeMode ? ["--smoke"] : [])], {
    cwd: l1Root,
    env: {
      ...process.env,
      ...(supervisorRoot ? { ZYRON_TESTNET_DATA_ROOT: supervisorRoot } : {})
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
    if (expectedChildStop || shuttingDown) return;
    if (smokeMode && code === 0) {
      process.exitCode = 0;
      return;
    }
    console.error(`Render private-testnet launcher exited: code=${code} signal=${signal}`);
    process.exitCode = typeof code === "number" && code !== 0 ? code : 1;
  });
}

async function stopChild(signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  expectedChildStop = true;
  child.kill(signal);
  await Promise.race([exited, sleep(childStopTimeoutMs)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(2_000)]);
  }
  expectedChildStop = false;
}

async function failClosed(message, exitCode = 70) {
  console.error(message);
  shuttingDown = true;
  await stopChild();
  process.exitCode = exitCode;
}

async function waitForSafeWallClock(requiredResumeMs) {
  const deadline = Date.now() + clockRecoveryTimeoutMs;
  let previous = Date.now();
  let stableSamples = 0;
  while (Date.now() < deadline) {
    await sleep(stableClockSampleIntervalMs);
    const now = Date.now();
    if (now >= previous) stableSamples += 1;
    else stableSamples = 0;
    previous = now;
    observeWallClock();
    if (now >= requiredResumeMs && stableSamples >= stableClockSamplesRequired) return;
  }
  throw new Error(`Wall clock did not recover to safe restart watermark ${requiredResumeMs}`);
}

async function waitForHealthyRestart(url, previousHeight, previousGenesisHash) {
  const deadline = Date.now() + finalityRecoveryTimeoutMs;
  let last;
  while (Date.now() < deadline) {
    observeWallClock();
    try {
      last = await fetchReady(url);
      const body = last.body;
      if (body?.genesisHash && previousGenesisHash && body.genesisHash !== previousGenesisHash) {
        throw new Error(`Supervised restart changed genesis: ${previousGenesisHash} -> ${body.genesisHash}`);
      }
      if (body?.genesisHash && body.materialReused !== true) {
        throw new Error("Supervised restart did not reuse existing genesis/validator material");
      }
      const faults = validatorClockFaults(body);
      if (faults.length) throw new Error(`Clock fault repeated after supervised restart: ${faults.join(",")}`);
      if (last.status === 200 && body?.ready === true && body?.minHeight >= previousHeight + 1 && body?.nodes?.every((node) => node.processAlive)) {
        return body;
      }
    } catch (error) {
      if (/changed genesis|did not reuse|Clock fault repeated/.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Supervised restart did not recover finality after height ${previousHeight}: ${JSON.stringify(last?.body)}`);
}

async function recoverClockFault(validators, summary, url, reason = "clock-fault") {
  if (clockRestartCount >= maxClockRestarts) {
    await failClosed(`Clock recovery restart budget exhausted after ${clockRestartCount} restart(s)`);
    return null;
  }
  const label = validators.length ? validators.join(",") : "unknown";
  const previousHeight = Number.isSafeInteger(summary?.minHeight) ? Number(summary.minHeight) : 0;
  const previousGenesisHash = typeof summary?.genesisHash === "string" ? summary.genesisHash : expectedGenesisHash;
  if (previousGenesisHash) expectedGenesisHash = expectedGenesisHash ?? previousGenesisHash;
  const requiredResumeMs = Math.max(highestObservedWallClockMs, Date.now()) + wallClockSafetyMarginMs;

  console.error(`Render rehearsal ${reason} detected on validator(s): ${label}; stopping launcher before recovery.`);
  console.error(`Preserving supervised data root and signing journals; restart is blocked until wall clock reaches ${requiredResumeMs}.`);
  await stopChild();

  try {
    await waitForSafeWallClock(requiredResumeMs);
  } catch (error) {
    await failClosed(`Clock recovery refused: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  clockRestartCount += 1;
  spawnLauncher();
  try {
    const recovered = await waitForHealthyRestart(url, previousHeight, previousGenesisHash);
    console.log(`Render rehearsal recovered with same genesis ${recovered.genesisHash} and advanced finality ${previousHeight} -> ${recovered.minHeight}; restart=${clockRestartCount}`);
    return recovered;
  } catch (error) {
    await failClosed(`Clock recovery failed closed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function monitor(url) {
  while (!shuttingDown) {
    observeWallClock();
    if (childExit && !expectedChildStop) return;
    try {
      const ready = await fetchReady(url);
      const body = ready.body;
      if (typeof body?.genesisHash === "string") {
        if (expectedGenesisHash && body.genesisHash !== expectedGenesisHash) {
          await failClosed(`Render rehearsal genesis changed unexpectedly: ${expectedGenesisHash} -> ${body.genesisHash}`);
          return;
        }
        expectedGenesisHash = expectedGenesisHash ?? body.genesisHash;
      }
      const faults = validatorClockFaults(body);
      if (faults.length) {
        if (monitorOnly) {
          await failClosed(`Fatal Render rehearsal clock fail-stop detected on validator(s): ${faults.join(",")}`);
          return;
        }
        await recoverClockFault(faults, body, url);
        continue;
      }
      if (testRecoveryOnce && !testRecoveryTriggered && ready.status === 200 && body?.ready === true && body?.minHeight >= 2) {
        testRecoveryTriggered = true;
        const recovered = await recoverClockFault([1], body, url, "CI recovery rehearsal");
        if (recovered) {
          console.log(JSON.stringify({
            status: "ok",
            scenario: "render-clock-same-data-supervised-recovery",
            previousHeight: body.minHeight,
            recoveredHeight: recovered.minHeight,
            genesisHash: recovered.genesisHash,
            materialReused: recovered.materialReused,
            restartCount: clockRestartCount,
            publicTestnetAuthorized: recovered.publicTestnetAuthorized,
            mainnetAuthorized: recovered.mainnetAuthorized,
            valueBearing: recovered.valueBearing
          }, null, 2));
          shuttingDown = true;
          await stopChild();
          process.exitCode = 0;
          return;
        }
      }
    } catch {
      // Startup/redeploy gaps are not clock faults. Unexpected child exit is handled separately.
    }
    await sleep(pollIntervalMs);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Render clock supervisor received ${signal}`);
  await stopChild(signal);
}

if (!monitorOnly) spawnLauncher();

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

const readyUrl = monitorOnly ? testUrl : `http://127.0.0.1:${gatewayPort}`;
await monitor(readyUrl);

if (monitorOnly && process.exitCode === undefined) {
  throw new Error("Clock supervisor monitor-only rehearsal ended without detecting a clock fault");
}
if (!configuredRoot && supervisorRoot && (shuttingDown || childExit)) {
  await rm(supervisorRoot, { recursive: true, force: true });
}
