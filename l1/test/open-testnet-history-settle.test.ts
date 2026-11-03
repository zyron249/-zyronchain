// The first snapshot build after a restart waits until the history rebuild has
// finished and settled (one more refresh cycle at the tip): deferred as
// history_settling, never skipped, and reported truthfully in /health.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts/open-testnet.mjs")).href);

test("readiness gate: an unsettled history near the tip defers as history_settling", () => {
  const gate = api.snapshotBuildReadiness;
  assert.equal(gate({ quorumOk: true, tip: 100, historyHeight: 100, historySettled: false }), "history_settling");
  assert.equal(gate({ quorumOk: true, tip: 100, historyHeight: 100, historySettled: true }), undefined);
  assert.equal(gate({ quorumOk: true, tip: 100, historyHeight: 100 }), undefined, "default: settled (callers without a tracker)");
  // Earlier reasons still win, so waitingFor names the real blocker.
  assert.equal(gate({ quorumOk: false, tip: 100, historyHeight: 100, historySettled: false }), "node_not_ready");
  assert.equal(gate({ quorumOk: true, tip: 100, historyHeight: 100, historyRebuilding: true, historySettled: false }), "history_catching_up");
  assert.equal(gate({ quorumOk: true, tip: 5_000, historyHeight: 1, historySettled: false }), "history_catching_up");
  assert.ok(api.SNAPSHOT_DEFERRED_CODES.has("history_settling"));
  assert.equal(api.snapshotErrorCode(Object.assign(new Error("x"), { code: "history_settling" })), "history_settling");
});

test("settle tracker: two consecutive cycles at the tip, a miss restarts the count, then it latches", () => {
  const t = api.createHistorySettleTracker();
  assert.equal(t.settled(), false);
  t.record(true); assert.equal(t.settled(), false, "reaching the tip once is not settled");
  t.record(false); t.record(true); assert.equal(t.settled(), false, "a behind cycle restarts the count");
  t.record(true); assert.equal(t.settled(), true);
  t.record(false); assert.equal(t.settled(), true, "latched");
});

test("first build is deferred during the rebuild, runs once the history settles, and /health says why", async () => {
  // Model of the gateway wiring: a refresher cycle moves the history toward
  // the tip and records it; the build is gated by snapshotBuildReadiness.
  const tip = 13_408; let height = 0; let rebuilding = true; let builds = 0;
  const settle = api.createHistorySettleTracker();
  const cycle = (step: number) => { height = Math.min(tip, height + step); if (height === tip) rebuilding = false; settle.record(!rebuilding && height >= tip); };
  const cache = api.createSnapshotCache({
    log: () => {}, currentHeight: async () => tip, buildTimeoutMs: 900_000, notReadyRetryMs: 0,
    build: async () => {
      const deferred = api.snapshotBuildReadiness({ quorumOk: true, tip, historyHeight: height, historyRebuilding: rebuilding, historySettled: settle.settled() });
      if (deferred) throw Object.assign(new Error(`snapshot build deferred (${deferred})`), { code: deferred });
      builds += 1;
      return { sealed: Buffer.from("x"), height: tip };
    }
  });
  await cache.refresh();
  assert.equal(cache.status().waitingFor, "history_catching_up");
  cycle(12_000); // rebuild still running, within the 2,000-block catch-up window
  await cache.refresh();
  assert.equal(builds, 0, "no build while the history is rebuilding");
  assert.equal(cache.status().waitingFor, "history_catching_up");
  cycle(10_000); // rebuild reaches the tip: not settled yet
  await cache.refresh();
  assert.equal(builds, 0);
  assert.equal(cache.status().waitingFor, "history_settling");
  assert.equal(cache.status().lastBuiltHeight, null);
  assert.equal(cache.status().failures, 0, "deferred, not a failure");
  assert.equal(cache.status().lastError, null);
  cycle(0); // one more refresh cycle at the tip: settled
  await cache.refresh();
  assert.equal(builds, 1, "deferred, not skipped: the build runs once settled");
  assert.equal(cache.status().waitingFor, null);
  assert.equal(cache.status().lastBuiltHeight, tip);
});
