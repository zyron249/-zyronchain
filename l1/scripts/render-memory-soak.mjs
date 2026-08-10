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
const WARMUP_HEIGHT = 4;
const FINAL_HEIGHT = 12;
const MAX_POST_WARMUP_GROWTH_BYTES = 96 * 1024 * 1024;
const EXPECTED_PROCESS_COUNT = 5; // launcher/gateway + four validator children

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

async function waitHeight(base, height, timeoutMs = 240_000) {
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
  if (pid === rootPid) return "gateway";
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
  assert.equal(processes.length, EXPECTED_PROCESS_COUNT, `Expected ${EXPECTED_PROCESS_COUNT} launcher/validator processes: ${JSON.stringify(processes)}`);
  assert.deepEqual(
    processes.map((entry) => entry.role),
    ["gateway", "validator-1", "validator-2", "validator-3", "validator-4"],
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
  await waitHeight(base, WARMUP_HEIGHT);
  const warmup = await treeMemory(child.pid);
  const samples = [{ height: WARMUP_HEIGHT, ...warmup }];

  let nextHeight = WARMUP_HEIGHT + 1;
  while (nextHeight <= FINAL_HEIGHT) {
    const current = await waitHeight(base, nextHeight);
    const memory = await treeMemory(child.pid);
    samples.push({ height: current.minHeight, ...memory });
    nextHeight = current.minHeight + 1;
  }

  const peakPostWarmupPssBytes = Math.max(...samples.map((sample) => sample.pssBytes));
  const finalPssBytes = samples.at(-1).pssBytes;
  const maxPostWarmupGrowthBytes = Math.max(0, peakPostWarmupPssBytes - warmup.pssBytes);
  assert.ok(
    maxPostWarmupGrowthBytes < MAX_POST_WARMUP_GROWTH_BYTES,
    `Post-warmup PSS growth exceeded budget: ${maxPostWarmupGrowthBytes}`
  );

  const finalStatus = await status(base);
  assert.equal(finalStatus.converged, true);
  assert.equal(finalStatus.nodes?.every((node) => node.processAlive), true);
  assert.equal(finalStatus.publicTestnetAuthorized, false);
  assert.equal(finalStatus.mainnetAuthorized, false);
  assert.equal(finalStatus.valueBearing, false);

  console.log(JSON.stringify({
    status: "ok",
    scenario: "render-four-validator-memory-soak",
    measurement: "linux-smaps-rollup-pss-growth",
    rationale: "CI PSS is used to detect post-warmup growth; the live Render cgroup metric is the authoritative absolute memory-limit signal",
    samples,
    warmupHeight: WARMUP_HEIGHT,
    finalTargetHeight: FINAL_HEIGHT,
    warmupPssBytes: warmup.pssBytes,
    peakPostWarmupPssBytes,
    finalPssBytes,
    maxPostWarmupGrowthBytes,
    maxGrowthBudgetBytes: MAX_POST_WARMUP_GROWTH_BYTES,
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
