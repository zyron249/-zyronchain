#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const launcher = resolve(repoRoot, "l1/scripts/render-private-testnet.mjs");
const HARD_PSS_BYTES = 430 * 1024 * 1024;
const MAX_GROWTH_BYTES = 128 * 1024 * 1024;
const EXPECTED_PROCESS_COUNT = 6; // supervisor + launcher/gateway + four validator children

async function freePort() {
  const server = createServer();
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

async function status(base) {
  const response = await fetch(`${base}/status`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`status HTTP ${response.status}`);
  return response.json();
}

async function waitHeight(base, height, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await status(base);
      if (last.minHeight >= height && last.nodes?.every((node) => node.processAlive)) return last;
    } catch {
      // Startup and bounded sampling races are retried until the deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`height ${height} timeout: ${JSON.stringify(last)}`);
}

function roleForProcess(pid, rootPid, args) {
  if (pid === rootPid) return "supervisor";
  if (args.includes("render-private-testnet-base.mjs")) return "gateway";
  for (let index = 0; index < 4; index += 1) {
    if (args.includes(`--port ${9137 + index}`)) return `validator-${index + 1}`;
  }
  return "unexpected-child";
}

async function linuxMemory(pid) {
  const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
  const pssKb = Number(rollup.match(/^Pss:\s+(\d+)\s+kB$/m)?.[1]);
  const rssKb = Number(rollup.match(/^Rss:\s+(\d+)\s+kB$/m)?.[1]);
  if (!Number.isSafeInteger(pssKb) || !Number.isSafeInteger(rssKb)) {
    throw new Error(`Unable to parse smaps_rollup for pid ${pid}`);
  }
  return { pssBytes: pssKb * 1024, rssBytes: rssKb * 1024 };
}

async function treeMemory(rootPid) {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="]);
  const rows = stdout.trim().split(/\n+/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) throw new Error(`Unable to parse ps row: ${line}`);
    return { pid: Number(match[1]), ppid: Number(match[2]), args: match[3] };
  });
  const rowByPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map();
  for (const row of rows) {
    const entries = children.get(row.ppid) ?? [];
    entries.push(row.pid);
    children.set(row.ppid, entries);
  }

  const stack = [rootPid];
  const seen = new Set();
  const processRows = [];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rowByPid.get(pid);
    if (row) processRows.push(row);
    for (const childPid of children.get(pid) ?? []) stack.push(childPid);
  }

  const processes = [];
  for (const row of processRows) {
    const memory = await linuxMemory(row.pid);
    processes.push({
      role: roleForProcess(row.pid, rootPid, row.args),
      pid: row.pid,
      ppid: row.ppid,
      ...memory
    });
  }
  processes.sort((left, right) => left.role.localeCompare(right.role));
  assert.equal(processes.length, EXPECTED_PROCESS_COUNT, `Expected ${EXPECTED_PROCESS_COUNT} supervised launcher/validator processes: ${JSON.stringify(processes)}`);
  assert.deepEqual(
    processes.map((entry) => entry.role),
    ["gateway", "supervisor", "validator-1", "validator-2", "validator-3", "validator-4"],
    `Unexpected process roles: ${JSON.stringify(processes)}`
  );
  return {
    pssBytes: processes.reduce((sum, process) => sum + process.pssBytes, 0),
    summedRssBytes: processes.reduce((sum, process) => sum + process.rssBytes, 0),
    processCount: processes.length,
    processes
  };
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [launcher], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    ZYRON_TESTNET_CHAIN_ID: `zyron-memory-soak-${process.pid}`
  },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 10_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

try {
  await waitHeight(base, 2);
  const baseline = await treeMemory(child.pid);
  const samples = [{ height: 2, ...baseline }];

  let nextHeight = 3;
  while (nextHeight <= 6) {
    const current = await waitHeight(base, nextHeight);
    const memory = await treeMemory(child.pid);
    samples.push({ height: current.minHeight, ...memory });
    assert.ok(memory.pssBytes < HARD_PSS_BYTES, `PSS exceeded hard budget: ${memory.pssBytes}`);
    nextHeight = current.minHeight + 1;
  }

  const peakPssBytes = Math.max(...samples.map((sample) => sample.pssBytes));
  const finalPssBytes = samples.at(-1).pssBytes;
  const growthBytes = finalPssBytes - baseline.pssBytes;
  assert.ok(growthBytes < MAX_GROWTH_BYTES, `PSS growth exceeded budget: ${growthBytes}`);

  const finalStatus = await status(base);
  assert.equal(finalStatus.converged, true);
  assert.equal(finalStatus.nodes?.every((node) => node.processAlive), true);
  assert.equal(finalStatus.publicTestnetAuthorized, false);
  assert.equal(finalStatus.mainnetAuthorized, false);
  assert.equal(finalStatus.valueBearing, false);

  console.log(JSON.stringify({
    status: "ok",
    scenario: "render-supervised-four-validator-memory-soak",
    measurement: "linux-smaps-rollup-pss",
    rationale: "PSS proportionally accounts shared pages; summed RSS is retained only as diagnostic evidence",
    samples,
    baselinePssBytes: baseline.pssBytes,
    peakPssBytes,
    finalPssBytes,
    growthBytes,
    hardBudgetBytes: HARD_PSS_BYTES,
    maxGrowthBytes: MAX_GROWTH_BYTES,
    expectedProcessCount: EXPECTED_PROCESS_COUNT,
    finalHeight: finalStatus.minHeight,
    validatorsAlive: true,
    publicTestnetAuthorized: false,
    mainnetAuthorized: false,
    valueBearing: false
  }, null, 2));
} finally {
  await stop();
}
