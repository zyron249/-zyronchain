#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const launcherPath = resolve(l1Root, "scripts/render-private-testnet.mjs");
const pollIntervalMs = 2_000;
const readyTimeoutMs = 1_500;
const childStopTimeoutMs = 8_000;
const monitorOnly = process.argv.includes("--test-monitor-only");
const smokeMode = process.argv.includes("--smoke");
const testUrl = process.env.ZYRON_SUPERVISOR_TEST_URL;
const gatewayPort = Number(process.env.PORT ?? 10000);

if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
  throw new Error("PORT must be a valid TCP port");
}
if (monitorOnly && (!testUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(testUrl))) {
  throw new Error("--test-monitor-only requires loopback ZYRON_SUPERVISOR_TEST_URL");
}

let child;
let shuttingDown = false;
let childExit;

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

async function stopChild(signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill(signal);
  await Promise.race([exited, sleep(childStopTimeoutMs)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function failClockFault(validators) {
  const label = validators.length ? validators.join(",") : "unknown";
  console.error(`Fatal Render rehearsal clock fail-stop detected on validator(s): ${label}`);
  console.error("Signing safety remains fail-closed; terminating the ephemeral rehearsal instead of weakening the clock guard.");
  shuttingDown = true;
  await stopChild();
  process.exitCode = 70;
}

async function monitor(url) {
  while (!shuttingDown) {
    if (childExit) return;
    try {
      const ready = await fetchReady(url);
      const faults = validatorClockFaults(ready.body);
      if (faults.length) {
        await failClockFault(faults);
        return;
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

if (!monitorOnly) {
  child = spawn(process.execPath, [launcherPath, ...(smokeMode ? ["--smoke"] : [])], {
    cwd: l1Root,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"]
  });
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
    if (shuttingDown) return;
    if (smokeMode && code === 0) {
      process.exitCode = 0;
      return;
    }
    console.error(`Render private-testnet launcher exited: code=${code} signal=${signal}`);
    process.exitCode = typeof code === "number" && code !== 0 ? code : 1;
  });
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

const readyUrl = monitorOnly ? testUrl : `http://127.0.0.1:${gatewayPort}`;
await monitor(readyUrl);

if (monitorOnly && process.exitCode === undefined) {
  throw new Error("Clock supervisor monitor-only rehearsal ended without detecting a clock fault");
}
