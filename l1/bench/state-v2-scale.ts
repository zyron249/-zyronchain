import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { StateV2DiskStore } from "../src/state-v2-store.js";

const worker = process.argv[2];
if (worker === "setup") {
  await setup(process.argv[3]!, parsePositiveInteger(process.argv[4]!, "account count"));
} else if (worker === "reopen") {
  await reopen(process.argv[3]!);
} else if (worker === "gc") {
  await garbageCollect(process.argv[3]!);
} else {
  await benchmark();
}

async function benchmark(): Promise<void> {
  const accounts = parsePositiveInteger(process.env.ZYRON_SCALE_ACCOUNTS ?? "10000", "ZYRON_SCALE_ACCOUNTS");
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-scale-"));
  const self = fileURLToPath(import.meta.url);
  try {
    const setupResult = runWorker(self, ["setup", directory, String(accounts)]) as SetupResult;
    const firstRestart = runWorker(self, ["reopen", directory]) as RestartResult;
    if (firstRestart.root !== setupResult.root) throw new Error("Scale restart changed the authenticated State v2 root");
    if (firstRestart.residentCacheRecords > 4_096) throw new Error("Scale restart exceeded the State v2 resolver cache bound");

    const gc = runWorker(self, ["gc", directory]) as GcResult;
    if (gc.root !== setupResult.root) throw new Error("State v2 GC changed the authenticated root");
    if (gc.removedNodes < 1) throw new Error("Scale GC did not remove historical State v2 objects");

    const secondRestart = runWorker(self, ["reopen", directory]) as RestartResult;
    if (secondRestart.root !== setupResult.root) throw new Error("Post-GC restart changed the authenticated State v2 root");
    if (secondRestart.residentCacheRecords > 4_096) throw new Error("Post-GC restart exceeded the resolver cache bound");

    console.log(JSON.stringify({
      accounts,
      setup: setupResult,
      firstRestart,
      gc,
      secondRestart,
      sqliteBytes: (await stat(join(directory, "state-v2.nodes.sqlite"))).size
    }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function setup(directory: string, accounts: number): Promise<void> {
  const started = performance.now();
  const store = await StateV2DiskStore.open(directory);
  let state = store.state();
  const batchSize = 250;
  for (let start = 0; start < accounts; start += batchSize) {
    const keys: string[] = [];
    for (let index = start; index < Math.min(accounts, start + batchSize); index += 1) {
      const key = `account:scale-${index}`;
      state = state.set(key, { balanceAtoms: index + 1, nonce: 0 });
      keys.push(key);
    }
    await store.commit(state, keys);
    state = store.state();
  }
  const churn = Math.min(accounts, 1_000);
  for (let start = 0; start < churn; start += batchSize) {
    const keys: string[] = [];
    for (let index = start; index < Math.min(churn, start + batchSize); index += 1) {
      const key = `account:scale-${index}`;
      state = state.set(key, { balanceAtoms: index + 2, nonce: 1 });
      keys.push(key);
    }
    await store.commit(state, keys);
    state = store.state();
  }
  const counts = objectCounts(directory);
  console.log(JSON.stringify({
    root: store.state().root(),
    setupMs: rounded(performance.now() - started),
    nodes: counts.nodes,
    semanticKeys: counts.semanticKeys
  } satisfies SetupResult));
}

async function reopen(directory: string): Promise<void> {
  const beforeHeap = process.memoryUsage().heapUsed;
  const started = performance.now();
  const store = await StateV2DiskStore.open(directory);
  const after = process.memoryUsage();
  console.log(JSON.stringify({
    root: store.state().root(),
    restartMs: rounded(performance.now() - started),
    heapDeltaMiB: rounded((after.heapUsed - beforeHeap) / (1024 * 1024)),
    rssMiB: rounded(after.rss / (1024 * 1024)),
    residentCacheRecords: store.residentNodeRecordCount()
  } satisfies RestartResult));
}

async function garbageCollect(directory: string): Promise<void> {
  const store = await StateV2DiskStore.open(directory);
  const before = objectCounts(directory);
  const started = performance.now();
  const removed = store.pruneHistoricalObjects();
  const after = objectCounts(directory);
  if (before.nodes - after.nodes !== removed.removedNodes ||
      before.semanticKeys - after.semanticKeys !== removed.removedSemanticKeys) {
    throw new Error("State v2 scale GC count mismatch");
  }
  console.log(JSON.stringify({
    root: store.state().root(),
    gcMs: rounded(performance.now() - started),
    beforeNodes: before.nodes,
    afterNodes: after.nodes,
    removedNodes: removed.removedNodes,
    removedSemanticKeys: removed.removedSemanticKeys
  } satisfies GcResult));
}

function objectCounts(directory: string): { nodes: number; semanticKeys: number } {
  const database = new Database(join(directory, "state-v2.nodes.sqlite"), { readonly: true });
  try {
    const nodes = (database.prepare("SELECT count(*) AS count FROM nodes").get() as { count: number }).count;
    const semanticKeys = (database.prepare("SELECT count(*) AS count FROM semantic_keys").get() as { count: number }).count;
    return { nodes, semanticKeys };
  } finally { database.close(); }
}

function runWorker(self: string, args: string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, [self, ...args], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024
  }).trim()) as unknown;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 1_000_000) throw new Error(`${label} is too large`);
  return parsed;
}

function rounded(value: number): number { return Number(value.toFixed(2)); }

interface SetupResult { root: string; setupMs: number; nodes: number; semanticKeys: number }
interface RestartResult { root: string; restartMs: number; heapDeltaMiB: number; rssMiB: number; residentCacheRecords: number }
interface GcResult {
  root: string; gcMs: number; beforeNodes: number; afterNodes: number;
  removedNodes: number; removedSemanticKeys: number;
}
