// Patron (Render OOM every 20-30 min): self-reported memory, bounded
// gateway structures, and a snapshot build that waits for readiness instead
// of running into the 900 s timeout after a restart.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const mod = (path: string) => import(pathToFileURL(join(l1Root, path)).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await mod("scripts/open-testnet.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mem: any = await mod("scripts/open-testnet/memory-report.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const relay: any = await mod("scripts/open-testnet/consensus-relay.mjs");

test("memory report: gateway memoryUsage fields, validator RSS from /proc, one compact log line", () => {
  const gateway = mem.gatewayMemory();
  for (const key of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"]) assert.ok(Number.isFinite(gateway[key]), key);
  const fakeProc = () => "Name:\tnode\nVmRSS:\t   81920 kB\n";
  assert.equal(mem.processRssBytes(1234, fakeProc), 81920 * 1024);
  assert.equal(mem.processRssBytes(1234, () => { throw new Error("gone"); }), undefined);
  assert.equal(mem.processRssBytes(-1), undefined);
  const report = mem.memoryReport({ gateway, validators: { v1: 80 * 1024 * 1024, v2: null }, snapshotChild: { maxRss: 100 * 1024 * 1024 } });
  assert.equal(report.totalRss, gateway.rss + 80 * 1024 * 1024);
  const line = mem.formatMemoryLine(report);
  assert.match(line, /^memory: total=[\d.]+MB gw rss=[\d.]+ heap=[\d.]+\/[\d.]+ ext=[\d.]+ ab=[\d.]+ \| v1=80\.0 v2=\? \| child peak=100\.0$/);
  assert.equal(line.includes("\n"), false);
  const inMb = mem.memoryReportMb({ gateway: { rss: 80 * 1024 * 1024, heapUsed: 1.5 * 1024 * 1024 }, snapshotChild: { running: true, maxRss: 2 * 1024 * 1024, lastBuildAt: "t" } });
  assert.deepEqual(inMb, { gateway: { rss: 80, heapUsed: 1.5 }, snapshotChild: { running: true, maxRss: 2, lastBuildAt: "t" } });
});

test("snapshot readiness gate: no quorum or a far-behind / rebuilding history defers the build", () => {
  const gate = api.snapshotBuildReadiness;
  assert.equal(gate({ quorumOk: false, tip: 100, historyHeight: 100 }), "node_not_ready");
  assert.equal(gate({ quorumOk: true, tip: undefined, historyHeight: 0 }), "node_not_ready");
  assert.equal(gate({ quorumOk: true, tip: 100, historyHeight: 100, historyRebuilding: true }), "history_catching_up");
  assert.equal(gate({ quorumOk: true, tip: 12_684 + 5_000, historyHeight: 12_684 }), "history_catching_up");
  assert.equal(gate({ quorumOk: true, tip: 12_700, historyHeight: 12_684 }), undefined);
});

test("first build after a restart: a not-ready node is retried at once, without backoff or the 900 s timeout", async () => {
  let clock = 0; let calls = 0; let ready = false;
  const cache = api.createSnapshotCache({
    now: () => clock, buildTimeoutMs: 900_000, log: () => {}, currentHeight: async () => 5,
    build: async () => {
      calls += 1;
      if (!ready) throw Object.assign(new Error("snapshot build deferred"), { code: "node_not_ready" });
      return { sealed: Buffer.from("x"), height: 5 };
    }
  });
  const started = Date.now();
  await cache.refresh();
  assert.equal(cache.status().failures, 0);
  assert.equal(cache.status().lastError, null);
  assert.equal(cache.status().waitingFor, "node_not_ready");
  await cache.refresh();
  assert.equal(calls, 2, "retried on the next tick, no backoff");
  ready = true; clock += 1;
  await cache.refresh();
  assert.equal(cache.status().lastBuiltHeight, 5);
  assert.equal(cache.status().waitingFor, null);
  assert.ok(Date.now() - started < 5_000);
  for (const code of ["node_not_ready", "history_catching_up"]) assert.equal(api.snapshotErrorCode(Object.assign(new Error("x"), { code })), code);
});

test("relay forward counters drop a target at zero, so client-chosen targets cannot accumulate", () => {
  const map = new Map();
  for (let i = 0; i < 10_000; i += 1) { map.set(`t${i}`, 1); relay.releaseForward(map, `t${i}`); }
  assert.equal(map.size, 0);
  map.set("a", 2); relay.releaseForward(map, "a"); assert.equal(map.get("a"), 1);
  relay.releaseForward(map, "missing"); assert.equal(map.has("missing"), false);
});

test("boot: a not-ready first build fails fast and is retried after ~30 s by its own timer, never hanging to build_timeout", async () => {
  let calls = 0; let ready = false; const logs: string[] = [];
  const cache = api.createSnapshotCache({
    buildTimeoutMs: 900_000, refreshMs: 3_600_000, notReadyRetryMs: 50, log: (l: string) => logs.push(l), currentHeight: async () => 7,
    build: async () => {
      calls += 1;
      if (!ready) throw Object.assign(new Error("snapshot build deferred (node_not_ready)"), { code: "node_not_ready" });
      return { sealed: Buffer.from("x"), height: 7 };
    }
  });
  const started = Date.now();
  cache.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1); assert.equal(cache.status().waitingFor, "node_not_ready"); assert.equal(cache.status().failures, 0);
  ready = true;
  await new Promise((r) => setTimeout(r, 150));
  cache.stop();
  assert.equal(calls, 2, "retried by the not-ready timer, not the hourly tick");
  assert.equal(cache.status().lastBuiltHeight, 7);
  assert.equal(cache.status().lastError, null);
  assert.ok(Date.now() - started < 2_000, "no 900 s hang");
  assert.equal(api.SNAPSHOT_NOT_READY_RETRY_MS, 30_000);
  assert.ok(!logs.some((l) => /build_timeout/.test(l)));
});
