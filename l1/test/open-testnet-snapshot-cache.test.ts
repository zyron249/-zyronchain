// GET /state/snapshot must answer from a background-built cache: building
// inline (reading and verifying every validator's history, then sealing the
// whole chain) outgrew the snapshot keeper's 300 s request timeout.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

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
  const cache = api.createSnapshotCache({ build: async () => { if (fail) throw new Error("boom"); return { sealed: Buffer.from("ok"), height }; }, currentHeight: async () => height, log: (l: string) => logs.push(l) });
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
