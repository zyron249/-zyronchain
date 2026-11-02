// GET /state/snapshot must answer from a background-built cache: building
// inline (reading and verifying every validator's history, then sealing the
// whole chain) outgrew the snapshot keeper's 300 s request timeout.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
const H = (n: number) => n.toString(16).padStart(64, "0");
const SECRET = "s".repeat(32);
const silent = () => {};

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("no cache yet: current() is empty, so the route answers 503 without building inline", () => {
  let builds = 0;
  const cache = api.createSnapshotCache({ build: async () => { builds += 1; return { sealed: Buffer.alloc(0), height: 1 }; }, currentHeight: async () => 1, log: silent });
  assert.equal(cache.current(), undefined);
  assert.equal(builds, 0);
  assert.ok(api.SNAPSHOT_RETRY_AFTER_SECONDS > 0);
});

test("a cached snapshot is returned immediately, even while a slow build runs", async () => {
  const slow = deferred<{ sealed: Buffer; height: number }>();
  let height = 5; let calls = 0;
  const cache = api.createSnapshotCache({
    build: async () => { calls += 1; return calls === 1 ? { sealed: Buffer.from("a"), height: 5 } : slow.promise; },
    currentHeight: async () => height, log: silent
  });
  await cache.refresh();
  height = 6; void cache.refresh();
  assert.equal(cache.building(), true);
  const started = performance.now();
  const served = cache.current();
  assert.ok(performance.now() - started < 5);
  assert.equal(served.height, 5); assert.equal(served.sealed.toString(), "a");
  slow.resolve({ sealed: Buffer.from("b"), height: 6 });
});

test("single-flight: concurrent refreshes share one build", async () => {
  const gate = deferred<{ sealed: Buffer; height: number }>();
  let builds = 0;
  const cache = api.createSnapshotCache({ build: () => { builds += 1; return gate.promise; }, currentHeight: async () => 3, log: silent });
  const all = Promise.all([cache.refresh(), cache.refresh(), cache.refresh({ force: true })]);
  gate.resolve({ sealed: Buffer.from("x"), height: 3 });
  const results = await all;
  assert.equal(builds, 1);
  assert.ok(results.every((r: { height: number }) => r.height === 3));
  assert.equal(cache.building(), false);
});

test("the cache refreshes only when the height grows and keeps one snapshot", async () => {
  let height = 10; let builds = 0;
  const cache = api.createSnapshotCache({ build: async () => { builds += 1; return { sealed: Buffer.from(String(height)), height }; }, currentHeight: async () => height, log: silent });
  await cache.refresh(); assert.equal(builds, 1);
  await cache.refresh(); assert.equal(builds, 1, "no rebuild at the same height");
  height = 12; await cache.refresh();
  assert.equal(builds, 2); assert.equal(cache.current().height, 12); assert.equal(cache.current().sealed.toString(), "12");
});

test("a failed build keeps the previous snapshot and is retried later", async () => {
  let height = 1; let fail = false; const logs: string[] = [];
  const cache = api.createSnapshotCache({ build: async () => { if (fail) throw new Error("boom"); return { sealed: Buffer.from("ok"), height }; }, currentHeight: async () => height, log: (l: string) => logs.push(l), backoffBaseMs: 0 });
  await cache.refresh();
  fail = true; height = 2; await cache.refresh();
  assert.equal(cache.current().height, 1); assert.match(cache.lastError(), /boom/); assert.match(logs[0] ?? "", /background build failed/);
  fail = false; await cache.refresh();
  assert.equal(cache.current().height, 2); assert.equal(cache.lastError(), undefined);
});

test("start() builds at once and then on the interval; stop() ends it", async () => {
  let height = 1; let builds = 0;
  const cache = api.createSnapshotCache({ build: async () => { builds += 1; return { sealed: Buffer.from("s"), height }; }, currentHeight: async () => height, refreshMs: 20, log: silent });
  cache.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(builds, 1);
  height = 2; await new Promise((r) => setTimeout(r, 60));
  cache.stop();
  assert.equal(cache.current().height, 2);
  const after = builds; height = 3; await new Promise((r) => setTimeout(r, 60));
  assert.equal(builds, after);
});

test("the cached bytes are the sealed bundle unchanged: they open and verify with the same secret", async () => {
  const bundle = { format: "ZYRON-OPEN-TESTNET-STATE-V1", createdAtMs: 1, blocks: [{ hash: H(1) }, { hash: H(2) }] };
  const sealed = api.sealSnapshot(bundle, SECRET);
  const cache = api.createSnapshotCache({ build: async () => ({ sealed, height: 2 }), currentHeight: async () => 2, log: silent });
  await cache.refresh();
  assert.equal(cache.current().sealed, sealed, "served bytes are exactly what sealSnapshot produced");
  assert.deepEqual(api.openSnapshot(cache.current().sealed, SECRET), bundle);
  assert.throws(() => api.openSnapshot(cache.current().sealed, "x".repeat(40)));
  const tip = await api.readPublishedSnapshotTip("http://x.invalid/s", SECRET, { fetchImpl: async () => new Response(cache.current().sealed, { status: 200 }) });
  assert.deepEqual(tip, { height: 2, tipHash: H(2) });
});



test("L1: a failed build backs off exponentially; 503 requests start at most one build per window", async () => {
  let t = 0; let builds = 0;
  const cache = api.createSnapshotCache({
    build: async () => { builds += 1; throw new Error("boom"); }, currentHeight: async () => 1, log: silent,
    now: () => t, backoffBaseMs: 1_000, backoffMaxMs: 4_000
  });
  for (let i = 0; i < 50; i += 1) { if (!cache.current()) await cache.refresh(); } // the PoC's 50 sequential 503s
  assert.equal(builds, 1, "one build for 50 requests inside the first window");
  assert.equal(cache.nextAttemptAtMs(), 1_000);
  t = 999; await cache.refresh(); assert.equal(builds, 1);
  t = 1_000; await cache.refresh(); assert.equal(builds, 2); assert.equal(cache.nextAttemptAtMs(), 3_000, "doubled to 2 s");
  t = 3_000; await cache.refresh(); assert.equal(cache.nextAttemptAtMs(), 7_000, "doubled to 4 s");
  t = 7_000; await cache.refresh(); assert.equal(cache.nextAttemptAtMs(), 11_000, "capped at backoffMaxMs");
  assert.equal(builds, 4); assert.equal(cache.failures(), 4);
});

test("L1: a successful build resets the backoff", async () => {
  let t = 0; let fail = true; let height = 1;
  const cache = api.createSnapshotCache({
    build: async () => { if (fail) throw new Error("boom"); return { sealed: Buffer.from("ok"), height }; },
    currentHeight: async () => height, log: silent, now: () => t, backoffBaseMs: 1_000
  });
  await cache.refresh(); assert.equal(cache.failures(), 1);
  fail = false; t = 1_000; await cache.refresh();
  assert.equal(cache.current().height, 1); assert.equal(cache.failures(), 0); assert.equal(cache.nextAttemptAtMs(), 0);
  height = 2; await cache.refresh(); assert.equal(cache.current().height, 2, "no backoff after success");
});

test("L2: a hung build times out, releases single-flight and building(), keeps the previous cache", async () => {
  let calls = 0; let height = 1; const logs: string[] = [];
  const cache = api.createSnapshotCache({
    build: () => { calls += 1; return calls === 1 ? Promise.resolve({ sealed: Buffer.from("old"), height: 1 }) : new Promise(() => {}); },
    currentHeight: async () => height, log: (l: string) => logs.push(l), buildTimeoutMs: 30, backoffBaseMs: 0
  });
  await cache.refresh();
  height = 2; const hung = cache.refresh();
  assert.equal(cache.building(), true);
  const result = await hung;
  assert.equal(cache.building(), false, "the relay skip is released");
  assert.equal(result.height, 1); assert.equal(cache.current().sealed.toString(), "old");
  assert.match(cache.lastError(), /timed out after 30 ms/); assert.match(logs.at(-1) ?? "", /background build failed/);
  const next = cache.refresh(); assert.equal(cache.building(), true); assert.notEqual(next, hung, "a new build can start");
  await next; assert.equal(calls, 3);
});

test("L2: a timed-out build's late result is ignored", async () => {
  const late = deferred<{ sealed: Buffer; height: number }>();
  const cache = api.createSnapshotCache({ build: () => late.promise, currentHeight: async () => 1, log: silent, buildTimeoutMs: 20 });
  await cache.refresh();
  late.resolve({ sealed: Buffer.from("late"), height: 9 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cache.current(), undefined);
});

test("L3: past maxAgeMs fresh() is empty; a re-check at the same tip restarts the age", async () => {
  let t = 0; let height = 5; let fail = false;
  const cache = api.createSnapshotCache({
    build: async () => { if (fail) throw new Error("x"); return { sealed: Buffer.from("s"), height }; },
    currentHeight: async () => height, log: silent, now: () => t, maxAgeMs: 1_000, backoffBaseMs: 0
  });
  await cache.refresh();
  t = 1_000; assert.equal(cache.fresh().height, 5); assert.equal(cache.ageSeconds(), 1);
  t = 1_001; assert.equal(cache.fresh(), undefined, "stale");
  await cache.refresh(); assert.equal(cache.fresh().height, 5, "tip unchanged: still current"); assert.equal(cache.ageSeconds(), 0);
  height = 999; fail = true; t = 2_002; await cache.refresh();
  assert.equal(cache.fresh(), undefined, "tip moved on and rebuilds fail: not served");
  assert.equal(cache.current().height, 5);
});

test("relay refresh is skipped while a snapshot build runs and resumes after", async () => {
  const gate = deferred<{ sealed: Buffer; height: number }>();
  const cache = api.createSnapshotCache({ build: () => gate.promise, currentHeight: async () => 1, log: silent });
  let extends_ = 0;
  const refreshHistory = api.createHistoryRefresher({ snapshots: cache, extend: async () => { extends_ += 1; }, log: silent });
  void cache.refresh();
  assert.equal(await refreshHistory(), "skipped"); assert.equal(extends_, 0);
  gate.resolve({ sealed: Buffer.from("s"), height: 1 }); await cache.refresh();
  assert.equal(await refreshHistory(), "extended"); assert.equal(extends_, 1);
  const failing = api.createHistoryRefresher({ snapshots: cache, extend: async () => { throw new Error("nope"); }, log: silent });
  assert.equal(await failing(), "failed");
});

async function serve(snapshots: unknown, opts: Record<string, unknown> = {}) {
  const server = createServer((req, res) => { api.serveSnapshotRoute(res, snapshots, { genesisHash: H(0), ...opts }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/state/snapshot`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("HTTP: no snapshot -> 503 with Retry-After and one background build", async () => {
  let builds = 0;
  const cache = api.createSnapshotCache({ build: async () => { builds += 1; throw new Error("boom"); }, currentHeight: async () => 1, log: silent });
  const s = await serve(cache);
  try {
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(s.url);
      assert.equal(r.status, 503); assert.equal(r.headers.get("retry-after"), String(api.SNAPSHOT_RETRY_AFTER_SECONDS));
      assert.match((await r.json()).error, /not built yet/);
    }
    assert.equal(builds, 1, "backoff: five 503s, one build");
  } finally { await s.close(); }
});

test("HTTP: fresh snapshot -> 200 with height and age headers; stale -> 503 with Retry-After and age", async () => {
  let t = 0; let height = 4; let fail = false;
  const cache = api.createSnapshotCache({
    build: async () => { if (fail) throw new Error("x"); return { sealed: Buffer.from("sealed"), height }; },
    currentHeight: async () => height, log: silent, now: () => t, maxAgeMs: 60_000
  });
  await cache.refresh();
  const s = await serve(cache);
  try {
    t = 12_000;
    const ok = await fetch(s.url);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get("x-zyron-snapshot-height"), "4");
    assert.equal(ok.headers.get("x-zyron-snapshot-age-s"), "12"); assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), "sealed");
    height = 5; fail = true; t = 61_000; await cache.refresh();
    const stale = await fetch(s.url);
    assert.equal(stale.status, 503); assert.equal(stale.headers.get("retry-after"), String(api.SNAPSHOT_RETRY_AFTER_SECONDS));
    assert.equal(stale.headers.get("x-zyron-snapshot-age-s"), "61"); assert.match((await stale.json()).error, /older than the max age/);
  } finally { await s.close(); }
});

test("HTTP: the rate limit applies only when a snapshot is served", async () => {
  let takes = 0;
  const cache = api.createSnapshotCache({ build: async () => ({ sealed: Buffer.from("s"), height: 1 }), currentHeight: async () => 1, log: silent });
  const s = await serve(cache, { takeRate: () => { takes += 1; return { allowed: false }; }, limited: (res: import("node:http").ServerResponse) => { res.writeHead(429); res.end(); } });
  try {
    assert.equal((await fetch(s.url)).status, 503); assert.equal(takes, 0);
    await cache.refresh();
    assert.equal((await fetch(s.url)).status, 429); assert.equal(takes, 1);
  } finally { await s.close(); }
});

// ---- worker_thread builds (event loop and GET /health never block) ----------
const { blockHash } = await import(pathToFileURL(join(l1Root, "dist", "src", "block.js")).href);
const { merkleRoot } = await import(pathToFileURL(join(l1Root, "dist", "src", "merkle.js")).href);

function syntheticChain(count: number, chainId = "zyron-worker-test-1", genesisHash = H(0xabc)) {
  const blocks: { header: Record<string, unknown>; hash: string; transactions: unknown[] }[] = [];
  let previous = genesisHash;
  for (let height = 1; height <= count; height += 1) {
    const header = { height, chainId, previousHash: previous, transactionRoot: merkleRoot([]), timestamp: height };
    const hash = blockHash(header);
    blocks.push({ header, hash, transactions: [] });
    previous = hash;
  }
  return { blocks, chainId, genesisHash };
}

// A stand-in worker that speaks the snapshot-worker protocol. `mode` per
// build: "slow" busy-waits (blocks the WORKER's thread, never the parent's),
// "crash" exits the thread ("crash-at-tip-2": only for tip 2), "hang" never answers.
function fakeWorker(mode: "slow" | "crash" | "hang" | "crash-at-tip-2", busyMs = 1_500): URL {
  const code = `
    import { parentPort } from "node:worker_threads";
    let builds = 0;
    parentPort.on("message", (m) => {
      if (m.type !== "build") return;
      builds += 1;
      const mode = ${JSON.stringify(mode)};
      if (mode === "crash" || (mode === "crash-at-tip-2" && m.tip === 2)) process.exit(3);
      if (mode === "hang") { for (;;) {} }
      const until = Date.now() + ${busyMs};
      while (Date.now() < until) {}
      const bytes = new TextEncoder().encode("sealed-" + m.tip);
      parentPort.postMessage({ type: "built", id: m.id, height: m.tip, sealed: bytes.buffer }, [bytes.buffer]);
    });`;
  return new URL(`data:text/javascript,${encodeURIComponent(code)}`);
}
const buildInput = (tip: number) => ({ blocks: syntheticChain(tip).blocks, tip, tipHash: H(1), chainId: "c", genesisHash: H(0), genesis: {}, network: {}, keys: {} });

test("worker: the real worker seals the same bundle format, ships only new blocks and never echoes the secret", { timeout: 60_000 }, async () => {
  const { blocks, chainId, genesisHash } = syntheticChain(40);
  const builder = api.createSnapshotWorkerBuilder({ secret: SECRET, chunkSize: 7 });
  try {
    const keys = { v1: H(0x11) };
    const genesis = { chainId }; const network = { genesisHash };
    const first = await builder.build({ blocks: blocks.slice(0, 25), tip: 25, tipHash: blocks[24]?.hash ?? "", chainId, genesisHash, genesis, network, keys, createdAtMs: 7 });
    assert.equal(first.height, 25);
    assert.deepEqual(api.openSnapshot(first.sealed, SECRET), { format: "ZYRON-OPEN-TESTNET-STATE-V1", createdAtMs: 7, genesis, network, keys, blocks: blocks.slice(0, 25) });
    // Same layout as sealSnapshot on the main thread: magic line, 12-byte IV, 16-byte tag.
    const local = api.sealSnapshot({ format: "ZYRON-OPEN-TESTNET-STATE-V1", createdAtMs: 7, genesis, network, keys, blocks: blocks.slice(0, 25) }, SECRET);
    assert.equal(first.sealed.length, local.length);
    assert.ok(first.sealed.subarray(0, 28).equals(local.subarray(0, 28)), "same magic header");
    const second = await builder.build({ blocks, tip: 40, tipHash: blocks[39]?.hash ?? "", chainId, genesisHash, genesis, network, keys, createdAtMs: 8 });
    assert.deepEqual(api.openSnapshot(second.sealed, SECRET).blocks, blocks);
    // The worker runs the whole-chain linkage check; its errors carry no secret.
    await assert.rejects(builder.build({ blocks, tip: 40, tipHash: H(0xdead), chainId, genesisHash, genesis, network, keys }), (error: Error) => {
      assert.match(error.message, /does not end at the live tip/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
  } finally {
    builder.terminate();
  }
});

test("worker: GET /health answers quickly while a slow build runs in the worker", { timeout: 30_000 }, async () => {
  const builder = api.createSnapshotWorkerBuilder({ secret: SECRET, workerUrl: fakeWorker("slow", 2_000) });
  const cache = api.createSnapshotCache({ build: ({ signal }: { signal: AbortSignal }) => builder.build(buildInput(3), { signal }), currentHeight: async () => 3, log: silent });
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ snapshotCache: cache.status() })); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    const building = cache.refresh();
    await new Promise((r) => setTimeout(r, 200));
    let maxMs = 0; let seenBuilding = false;
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      maxMs = Math.max(maxMs, performance.now() - started);
      if (body.snapshotCache.building) { seenBuilding = true; assert.equal(typeof body.snapshotCache.startedAt, "string"); assert.ok(body.snapshotCache.durationMs >= 0); }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(seenBuilding, "health saw the build in progress");
    assert.ok(maxMs < 500, `health took ${Math.round(maxMs)} ms during a build`);
    await building;
    const status = cache.status();
    assert.equal(status.building, false); assert.equal(status.lastBuiltHeight, 3); assert.equal(status.lastError, null);
    assert.equal(status.age, 0); assert.ok(status.durationMs >= 1_500);
    assert.equal(cache.current().sealed.toString(), "sealed-3");
  } finally {
    server.close(); builder.terminate();
  }
});

test("worker: a crashed worker fails the build, is replaced, and the next build succeeds", { timeout: 30_000 }, async () => {
  const builder = api.createSnapshotWorkerBuilder({ secret: SECRET, workerUrl: fakeWorker("crash-at-tip-2", 10) });
  let height = 2;
  const cache = api.createSnapshotCache({ build: ({ signal }: { signal: AbortSignal }) => builder.build(buildInput(height), { signal }), currentHeight: async () => height, log: silent, backoffBaseMs: 0 });
  try {
    await cache.refresh();
    assert.equal(cache.current(), undefined);
    assert.equal(cache.status().lastError, "worker_crashed");
    assert.match(cache.lastError(), /snapshot worker exited \(code 3\)/);
    assert.equal(cache.status().building, false); assert.equal(builder.running(), false);
    height = 3;
    // The same builder starts a fresh worker, ships the whole history again and builds.
    await cache.refresh();
    assert.equal(cache.status().lastError, null); assert.equal(cache.status().lastBuiltHeight, 3);
    assert.equal(cache.current().sealed.toString(), "sealed-3");
  } finally {
    builder.terminate();
  }
});

test("worker: a hung worker is terminated at the build timeout and the previous snapshot is kept", { timeout: 30_000 }, async () => {
  const builder = api.createSnapshotWorkerBuilder({ secret: SECRET, workerUrl: fakeWorker("hang") });
  let calls = 0;
  const cache = api.createSnapshotCache({
    build: ({ signal }: { signal: AbortSignal }) => { calls += 1; return calls === 1 ? Promise.resolve({ sealed: Buffer.from("old"), height: 1 }) : builder.build(buildInput(2), { signal }); },
    currentHeight: async () => (calls === 0 ? 1 : 2), log: silent, buildTimeoutMs: 300, backoffBaseMs: 0
  });
  try {
    await cache.refresh();
    const started = performance.now();
    await cache.refresh();
    assert.ok(performance.now() - started < 5_000);
    assert.equal(cache.status().lastError, "build_timeout");
    assert.match(cache.lastError(), /timed out after 300 ms/);
    assert.equal(cache.status().building, false);
    assert.equal(cache.status().lastBuiltHeight, 1);
    assert.equal(cache.current().sealed.toString(), "old");
    assert.equal(builder.running(), false, "the hung worker was terminated");
  } finally {
    builder.terminate();
  }
});

test("lastError is sanitised: secret and key-sized hex redacted, one line, bounded", () => {
  const message = `boom ${SECRET} key ${"ab".repeat(32)}\nline2\u0007${"x".repeat(400)}`;
  const clean = api.sanitizeSnapshotError(new Error(message), { redact: [SECRET] });
  assert.ok(!clean.includes(SECRET)); assert.ok(!clean.includes("ab".repeat(32)));
  assert.ok(!/[\u0000-\u001f]/.test(clean)); assert.ok(clean.length <= 200);
  assert.match(clean, /^boom \[redacted\] key \[redacted\] line2/);
  // The cache always stores a sanitised message.
  const cache = api.createSnapshotCache({ build: async () => { throw new Error(`bad ${"cd".repeat(40)}`); }, currentHeight: async () => 1, log: silent });
  return cache.refresh().then(() => { assert.equal(cache.lastError(), "bad [redacted]"); assert.equal(cache.status().lastError, "build_failed"); assert.equal(cache.status().lastBuiltHeight, null); assert.equal(cache.status().age, null); });
});

// ---- Security Lows on #1161 --------------------------------------------------
test("L-A: collectSnapshotBlocks passes the abort signal to readers and stops when aborted", async () => {
  const { blocks, chainId, genesisHash } = syntheticChain(5);
  const controller = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  const readers = [{ name: "v1", read: async (from: number, limit: number, options: { signal?: AbortSignal } = {}) => {
    seen.push(options.signal); controller.abort();
    return blocks.slice(from - 1, from - 1 + Math.min(limit, 1));
  } }];
  const history = { chain: { genesisHash, height: 0, acceptBlock() { history.chain.height += 1; } }, blocks: [] as unknown[] };
  await assert.rejects(api.collectSnapshotBlocks(readers, { tip: 5, tipHash: blocks[4]?.hash, chainId, genesisHash, history, pageSize: 1, signal: controller.signal }), (error: Error & { code?: string }) => error.code === "aborted");
  assert.equal(seen[0], controller.signal);
  assert.ok(history.blocks.length <= 1, `kept reading after abort (${history.blocks.length} blocks)`);
  // Already aborted: no reader is called at all.
  let calls = 0;
  await assert.rejects(api.collectSnapshotBlocks([{ name: "v1", read: async () => { calls += 1; return []; } }], { tip: 1, tipHash: H(1), chainId, genesisHash, history: { chain: { genesisHash, height: 0 }, blocks: [] }, signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
});

test("L-A: the cache's build timeout aborts the signal its build received", async () => {
  let aborted = false;
  const cache = api.createSnapshotCache({ build: ({ signal }: { signal: AbortSignal }) => { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); }, currentHeight: async () => 1, log: silent, buildTimeoutMs: 30 });
  await cache.refresh();
  assert.equal(aborted, true); assert.equal(cache.status().lastError, "build_timeout");
});

test("L-B: /health lastError is a fixed code; the cache redacts its redact list and paths in the logged detail", async () => {
  const secret = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODk=";
  const lines: string[] = [];
  const cache = api.createSnapshotCache({ build: async () => { throw new Error(`ENOENT: open '/srv/net/keys/founder.json' ${secret}`); }, currentHeight: async () => 1, log: (line: string) => lines.push(line), redact: [secret] });
  await cache.refresh();
  assert.equal(cache.status().lastError, "build_failed");
  const detail = cache.lastError();
  assert.ok(!detail.includes(secret)); assert.ok(!detail.includes("/srv/net")); assert.ok(!detail.includes("founder.json"));
  assert.ok(lines.every((line) => !line.includes(secret) && !line.includes("/srv/net")));
  assert.equal(api.sanitizeSnapshotError(new Error("open C:\\data\\keys\\v1.json failed")), "open [path] failed");
  assert.equal(api.snapshotErrorCode(new api.SnapshotBuildTimeoutError(5)), "build_timeout");
  assert.equal(api.snapshotErrorCode(new Error("snapshot history: no validator served a block 3 that passes finalized-block validation")), "history_unavailable");
  assert.equal(api.snapshotErrorCode(Object.assign(new Error("x"), { code: "Bad Code!" })), "build_failed");
});

test("L-C: the worker has resource limits by default and streams the same bundle as sealSnapshot", { timeout: 60_000 }, async () => {
  assert.ok(api.SNAPSHOT_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb > 0);
  assert.ok(api.SNAPSHOT_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb < 512);
  const { sealSnapshotStream } = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet", "snapshot-seal.mjs")).href);
  const { blocks, chainId } = syntheticChain(300);
  const bundle = { format: "ZYRON-OPEN-TESTNET-STATE-V1", createdAtMs: 9, genesis: { chainId }, network: { a: 1 }, keys: { v1: H(2) }, blocks };
  const sealed = await sealSnapshotStream(bundle, SECRET, { batchBytes: 1024 });
  assert.deepEqual(api.openSnapshot(sealed, SECRET), bundle);
  assert.ok(sealed.subarray(0, 28).equals(api.sealSnapshot(bundle, SECRET).subarray(0, 28)));
});

test("L-C: a worker that exceeds its heap limit fails the build with worker_out_of_memory, not the process", { timeout: 60_000 }, async () => {
  const code = `import { parentPort } from "node:worker_threads"; const hog = []; parentPort.on("message", (m) => { if (m.type !== "build") return; for (;;) hog.push(new Array(1e5).fill({ x: Math.random() })); });`;
  const builder = api.createSnapshotWorkerBuilder({ secret: SECRET, workerUrl: new URL(`data:text/javascript,${encodeURIComponent(code)}`), resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 } });
  const cache = api.createSnapshotCache({ build: ({ signal }: { signal: AbortSignal }) => builder.build(buildInput(2), { signal }), currentHeight: async () => 2, log: silent });
  try {
    await cache.refresh();
    assert.equal(cache.status().lastError, "worker_out_of_memory");
    assert.equal(builder.running(), false);
  } finally { builder.terminate(); }
});

test("L-D: a busy worker does not count toward the backoff", async () => {
  let calls = 0;
  const cache = api.createSnapshotCache({ build: async () => { calls += 1; if (calls === 1) throw new api.SnapshotWorkerBusyError(); return { sealed: Buffer.from("ok"), height: 1 }; }, currentHeight: async () => 1, log: silent });
  await cache.refresh();
  assert.equal(cache.failures(), 0); assert.equal(cache.status().lastError, null); assert.equal(cache.nextAttemptAtMs(), 0);
  await cache.refresh();
  assert.equal(calls, 2); assert.equal(cache.current().height, 1);
  // A real failure still backs off.
  const failing = api.createSnapshotCache({ build: async () => { throw new Error("boom"); }, currentHeight: async () => 1, log: silent });
  await failing.refresh(); assert.equal(failing.failures(), 1);
});

// Security Medium-1 on #1164 and #1165 Low-1: with the relay off, the only
// history catch-up trigger is a build deferred as history_catching_up, which
// calls refreshHistory() from inside its own in-flight window. That refresh
// must not be lost, and the deferred build must be retried once the window
// ends, so builds resume without a restart (also after a history read error).
test("relay off: restore far behind plus a history read error recovers and builds resume without a restart", async () => {
  const tip = 10_000; let historyHeight = 100; let readFailures = 1; let extendCalls = 0; let built = 0;
  // eslint-disable-next-line prefer-const
  let refreshHistory: any;
  const cache = api.createSnapshotCache({
    build: async () => {
      const deferredCode = api.snapshotBuildReadiness({ quorumOk: true, tip, historyHeight });
      if (deferredCode) {
        if (deferredCode === "history_catching_up") void refreshHistory();
        throw Object.assign(new Error(`snapshot build deferred (${deferredCode})`), { code: deferredCode });
      }
      built += 1; return { sealed: Buffer.from("s"), height: tip };
    },
    currentHeight: async () => tip, log: silent, refreshMs: 3_600_000, notReadyRetryMs: 10
  });
  refreshHistory = api.createHistoryRefresher({
    snapshots: cache, retryMs: 5, log: silent,
    extend: async () => { extendCalls += 1; if (readFailures > 0) { readFailures -= 1; throw new Error("history file: read failed (EIO)"); } historyHeight = tip; }
  });
  cache.start(); // no relay timer; only the cache's own (hour-long) tick
  try {
    const deadline = Date.now() + 3_000;
    while (built === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(built, 1, "a build completed without a restart");
    assert.ok(extendCalls >= 2, "the read error was retried");
    assert.equal(cache.fresh().height, tip);
    assert.equal(cache.status().waitingFor, null);
  } finally { cache.stop(); refreshHistory.cancel(); }
});

test("a refresh skipped during an in-flight build runs once the build ends", async () => {
  const gate = deferred<{ sealed: Buffer; height: number }>();
  const cache = api.createSnapshotCache({ build: () => gate.promise, currentHeight: async () => 1, log: silent });
  let extends_ = 0;
  const refreshHistory = api.createHistoryRefresher({ snapshots: cache, extend: async () => { extends_ += 1; }, log: silent, retryMs: 5 });
  const run = cache.refresh();
  assert.equal(await refreshHistory(), "skipped");
  await new Promise((r) => setTimeout(r, 30)); assert.equal(extends_, 0, "still building: retry waits");
  gate.resolve({ sealed: Buffer.from("s"), height: 1 }); await run;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(extends_, 1, "deferred refresh ran after inFlight cleared");
  refreshHistory.cancel();
});
