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
