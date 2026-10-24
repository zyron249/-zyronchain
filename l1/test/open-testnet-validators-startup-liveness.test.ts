// The open TESTNET restarted in a loop for about 19 hours: once the validator
// processes start, the gateway answered /health 200 "starting" for a fixed
// 10 minutes, but replay on a small instance takes longer, so the host health
// check restarted the instance mid-replay. Liveness in the validators phase
// must follow start-up progress (with a stall window and a hard cap), and
// /readyz must stay strict.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
const MIN = 60_000;

function tracker(startMs: number, opts: Record<string, number> = {}) {
  let now = startMs;
  const t = api.createStartupProgress({ stallMs: 5 * MIN, maxMs: 90 * MIN, now: () => now, startedAtMs: startMs, ...opts });
  return { t, set: (ms: number) => { now = startMs + ms; } };
}

test("validators phase: /health stays 200 starting past 10 minutes while replay progresses", () => {
  const { t, set } = tracker(1_000_000);
  for (let m = 0; m <= 40; m += 2) { set(m * MIN); t.observe(`fingerprint-${m}`); }
  const v = t.liveness({ ok: false, everReady: false, path: "/health" });
  assert.equal(v.starting, true);
  assert.equal(v.code, 200);
  assert.equal(v.status, "starting");
  assert.equal(v.progress.elapsedMs, 40 * MIN);
  assert.equal(v.progress.sinceProgressMs, 0);
});

test("validators phase: no progress for the stall window goes 503 degraded", () => {
  const { t, set } = tracker(1_000_000);
  set(1 * MIN); t.observe("a");
  set(1 * MIN + 5 * MIN - 1); t.observe("a");
  assert.equal(t.liveness({ ok: false, everReady: false, path: "/health" }).code, 200);
  set(1 * MIN + 5 * MIN + 1); t.observe("a");
  const v = t.liveness({ ok: false, everReady: false, path: "/health" });
  assert.equal(v.code, 503);
  assert.equal(v.status, "degraded");
  assert.equal(v.starting, false);
  assert.equal(v.progress.stalled, true);
});

test("validators phase: past the hard cap goes 503 even while progressing", () => {
  const { t, set } = tracker(1_000_000);
  set(90 * MIN - 1); t.observe("x");
  assert.equal(t.liveness({ ok: false, everReady: false, path: "/health" }).code, 200);
  set(90 * MIN + 1); t.observe("y");
  const v = t.liveness({ ok: false, everReady: false, path: "/health" });
  assert.equal(v.code, 503);
  assert.equal(v.progress.capped, true);
});

test("validators phase: /readyz stays strict and a lost quorum after ready is 503", () => {
  const { t, set } = tracker(1_000_000);
  set(20 * MIN); t.observe("z");
  assert.equal(t.liveness({ ok: false, everReady: false, path: "/readyz" }).code, 503);
  assert.equal(t.liveness({ ok: true, everReady: true, path: "/readyz" }).code, 200);
  assert.equal(t.liveness({ ok: true, everReady: true, path: "/health" }).status, "ready");
  const lost = t.liveness({ ok: false, everReady: true, path: "/health" });
  assert.equal(lost.code, 503);
  assert.equal(lost.status, "degraded");
});

test("startup liveness limits come from env with sane defaults", () => {
  assert.deepEqual(api.parseStartupLimits({}), { stallMs: 5 * MIN, maxMs: 90 * MIN });
  assert.ok(api.parseStartupLimits({}).maxMs >= 60 * MIN);
  assert.deepEqual(api.parseStartupLimits({ ZYRON_STARTUP_STALL_MS: "120000", ZYRON_STARTUP_MAX_MS: "7200000" }), { stallMs: 120_000, maxMs: 7_200_000 });
  for (const bad of ["", "abc", "-1", "0", "1.5"]) assert.deepEqual(api.parseStartupLimits({ ZYRON_STARTUP_STALL_MS: bad, ZYRON_STARTUP_MAX_MS: bad }), { stallMs: 5 * MIN, maxMs: 90 * MIN }, bad);
});
