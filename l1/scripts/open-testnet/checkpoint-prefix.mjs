// Controller for the boot-time prefix verifier worker (#1197 option a).
// Security: one worker, ~64 MB heap, env {}, no SHARE_ENV, no secret in
// workerData, cancelled on mismatch, rebuild, discard or shutdown. Patron:
// the full prefix is checked on every boot (no verified-height marker), and
// the worker never overlaps the history rebuild or a snapshot build (the
// caller's gate, plus a deferred build code while it runs).
import { Worker } from "node:worker_threads";

export const PREFIX_WORKER_URL = new URL("./checkpoint-prefix-worker.mjs", import.meta.url);
export const PREFIX_WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 });

export function prefixWorkerOptions({ historyPath, checkpointPath, chainId, genesisHash, genesis }) {
  // Only these five fields; never a secret.
  return { workerData: { historyPath, checkpointPath, chainId, genesisHash, genesis }, env: {}, resourceLimits: { ...PREFIX_WORKER_RESOURCE_LIMITS }, stdout: false, stderr: false };
}

// Accept a worker pass only if it covers exactly the checkpoint the main
// thread holds and the bytes the main thread scanned. Returns undefined when
// it matches, else the reason.
export function checkPrefixResult(result, record, mainView) {
  if (!result || result.ok !== true) return `worker refused the prefix (${result?.reason ?? "no result"})`;
  if (result.height !== record.height) return `worker height ${result.height} differs from the checkpoint ${record.height}`;
  if (result.stateHash !== record.stateHash) return "worker checked a different checkpoint";
  if (result.runningHash !== record.historyRunningHash) return "worker running hash differs from the checkpoint";
  if (!mainView || result.runningHash !== mainView.runningHash || mainView.height !== record.height) return "worker running hash differs from the main thread's scan";
  if (result.tipHash !== record.tipHash) return "worker prefix does not end at the checkpoint tip";
  return undefined;
}

// job.result resolves with the worker's message, or rejects with
// { cancelled: true } after cancel(), or with the crash/exit error.
export function startPrefixWorker(options, { WorkerImpl = Worker } = {}) {
  const worker = new WorkerImpl(PREFIX_WORKER_URL, prefixWorkerOptions(options));
  let settled = false; let cancelled = false;
  const startedAt = performance.now();

  const result = new Promise((resolve, reject) => {
    worker.once("message", (message) => { settled = true; resolve(message); void worker.terminate(); });
    worker.once("error", (error) => { if (!settled) { settled = true; reject(cancelled ? Object.assign(new Error("prefix worker cancelled"), { cancelled: true }) : error); } });
    worker.once("exit", (code) => { if (!settled) { settled = true; reject(cancelled ? Object.assign(new Error("prefix worker cancelled"), { cancelled: true }) : new Error(`prefix worker exited (${code})`)); } });
  });
  result.catch(() => {});
  return {
    result,
    running: () => !settled,
    startedAt,
    elapsedMs: () => Math.round(performance.now() - startedAt),
    cancel() { if (settled) return; cancelled = true; void worker.terminate(); }
  };
}

// Timeout on the worker result, counted from its start: about 3x the
// expected time (~6 ms per block measured locally), at least 2 minutes.
export const PREFIX_WORKER_MS_PER_BLOCK = 18;
export const PREFIX_WORKER_MIN_TIMEOUT_MS = 120_000;
export function prefixWorkerTimeoutMs(height, override) {
  if (Number.isSafeInteger(override) && override > 0) return override;
  return Math.max(PREFIX_WORKER_MIN_TIMEOUT_MS, height * PREFIX_WORKER_MS_PER_BLOCK);
}
// Await the worker with a deadline. Resolves with the result, or with
// undefined when the worker timed out (it is cancelled) or failed with a file
// error, so the caller runs the serial check. A cancellation rethrows.
export async function awaitPrefixResult(job, { deadlineMs, onFallback = () => {} }) {
  let timer;
  const timeout = new Promise((done) => { timer = setTimeout(() => done("timeout"), Math.max(0, deadlineMs - performance.now())); });
  try {
    const outcome = await Promise.race([job.result, timeout]);
    if (outcome === "timeout") { job.cancel(); onFallback("timed out"); return undefined; }
    if (outcome?.ok === false && outcome.io) { onFallback(`file error: ${outcome.reason}`); return undefined; }
    return outcome;
  } finally { clearTimeout(timer); }
}
// Start gate on cgroup memory: memory.current of this process's cgroup v2
// must be below the limit. Unreadable (no cgroup v2) counts as open.
export const PREFIX_WORKER_MEMORY_LIMIT_BYTES = 400 * 1024 * 1024;
export async function readCgroupMemoryCurrent({ readFileImpl } = {}) {
  const read = readFileImpl ?? (await import("node:fs/promises")).readFile;
  try {
    const line = (await read("/proc/self/cgroup", "utf8")).split("\n").find((l) => l.startsWith("0::"));
    if (!line) return undefined;
    const value = Number((await read(`/sys/fs/cgroup${line.slice(3).trim()}/memory.current`, "utf8")).trim());
    return Number.isSafeInteger(value) ? value : undefined;
  } catch { return undefined; }
}
export function prefixMemoryGateOpen(current, limit = PREFIX_WORKER_MEMORY_LIMIT_BYTES) {
  return current === undefined || current < limit;
}
