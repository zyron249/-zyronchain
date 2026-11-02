#!/usr/bin/env node
// Tests for .github/scripts/open-testnet-lag-detector.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS, detect } from "./open-testnet-lag-detector.mjs";

const MIN = 60_000;
const T0 = Date.parse("2026-11-02T15:00:00Z");
const s = (i, height, durableHeight, step = MIN) => ({ ts: T0 + i * step, height, durableHeight });

test("defaults", () => {
  assert.deepEqual({ ...DEFAULTS }, { maxLag: 20, consecutive: 3, staleMinutes: 20 });
});

test("lag of exactly 20 does not fire", () => {
  const r = detect([s(0, 120, 100), s(1, 120, 100), s(2, 120, 100), s(3, 120, 100)]);
  assert.equal(r.alarm, false);
  assert.equal(r.reason, null);
  assert.equal(r.lag, 20);
});

test("lag 21 for 2 samples does not fire, for 3 samples fires", () => {
  const two = detect([s(0, 100, 100), s(1, 121, 100), s(2, 121, 100)]);
  assert.equal(two.alarm, false);
  assert.equal(two.reason, null);
  const three = detect([s(0, 100, 100), s(1, 121, 100), s(2, 121, 100), s(3, 121, 100)]);
  assert.equal(three.alarm, true);
  assert.equal(three.reason, "lag");
  assert.equal(three.lag, 21);
});

test("run resets when lag recovers between samples", () => {
  const r = detect([s(0, 121, 100), s(1, 121, 100), s(2, 125, 110), s(3, 135, 110), s(4, 135, 110)]);
  assert.equal(r.alarm, false);
  assert.equal(r.reason, null);
  const r2 = detect([s(0, 121, 100), s(1, 121, 100), s(2, 125, 110), s(3, 135, 110), s(4, 135, 110), s(5, 135, 110)]);
  assert.equal(r2.reason, "lag");
});

test("lag uses max height seen so far, not the current sample", () => {
  const r = detect([s(0, 130, 100), s(1, 110, 100), s(2, 110, 100)]);
  assert.equal(r.reason, "lag");
  assert.equal(r.lag, 30);
});

test("stale timer: 19 minutes no alarm, 21 minutes alarm", () => {
  const base = [s(0, 100, 95), s(1, 101, 95)];
  const at19 = detect(base, { now: T0 + 19 * MIN });
  assert.equal(at19.alarm, false);
  assert.equal(at19.staleMs, 19 * MIN);
  const at21 = detect(base, { now: T0 + 21 * MIN });
  assert.equal(at21.alarm, true);
  assert.equal(at21.reason, "stale");
  assert.equal(at21.staleMs, 21 * MIN);
});

test("stale timer restarts when durableHeight advances", () => {
  const r = detect([s(0, 100, 95), s(10, 105, 96), s(15, 106, 96)], { now: T0 + 25 * MIN });
  assert.equal(r.alarm, false);
  assert.equal(r.staleMs, 15 * MIN);
});

test("no stale alarm when height is frozen too (chain halt, not a durability gap)", () => {
  const r = detect([s(0, 100, 95), s(1, 100, 95)], { now: T0 + 60 * MIN });
  assert.equal(r.alarm, false);
  assert.equal(r.reason, null);
});

test("samples with missing or non-numeric heights are skipped", () => {
  const bad = [
    { ts: T0 + 2 * MIN, height: undefined, durableHeight: 100 },
    { ts: T0 + 3 * MIN, height: "130", durableHeight: 100 },
    { ts: T0 + 4 * MIN, height: 130, durableHeight: NaN },
    { ts: T0 + 5 * MIN, height: Infinity, durableHeight: 100 },
    { ts: T0 + 6 * MIN }
  ];
  // Two lagging valid samples + junk: the junk must not complete the run.
  const r = detect([s(0, 121, 100), s(1, 121, 100), ...bad]);
  assert.equal(r.alarm, false);
  assert.equal(r.reason, null);
  // Junk must not break a run either: third valid sample after junk fires.
  const r2 = detect([s(0, 121, 100), s(1, 121, 100), ...bad, s(7, 121, 100)]);
  assert.equal(r2.reason, "lag");
  // All junk: insufficient-data, no alarm, no throw.
  assert.deepEqual(detect(bad), { alarm: false, reason: "insufficient-data", lag: null, staleMs: null });
});

test("empty input returns insufficient-data", () => {
  assert.deepEqual(detect([]), { alarm: false, reason: "insufficient-data", lag: null, staleMs: null });
});

test("non-monotonic or non-finite ts throws", () => {
  assert.throws(() => detect([s(1, 1, 1), s(0, 1, 1)]), RangeError);
  assert.throws(() => detect([s(0, 1, 1), s(0, 1, 1)]), RangeError);
  assert.throws(() => detect([{ ts: NaN, height: 1, durableHeight: 1 }]), TypeError);
  assert.throws(() => detect([{ height: 1, durableHeight: 1 }]), TypeError);
  assert.throws(() => detect("nope"), TypeError);
  assert.throws(() => detect([s(5, 1, 1)], { now: T0 }), RangeError);
});

// Nov 2 incident: durableHeight stuck at 12966 from 10:28 to 11:26 ET
// (15:28-16:26 UTC) while height kept rising; keeper samples every 45 s.
function incident() {
  const start = Date.parse("2026-11-02T15:28:00Z");
  const end = Date.parse("2026-11-02T16:26:00Z");
  const out = [];
  for (let ts = start, i = 0; ts <= end; ts += 45_000, i++) {
    out.push({ ts, height: 12966 + 2 * i, durableHeight: 12966 }); // ~1 block / 22.5 s
  }
  return { start, out };
}

function firstAlarm(samples, opts) {
  for (let n = 1; n <= samples.length; n++) {
    const r = detect(samples.slice(0, n), opts);
    if (r.alarm) return { n, r };
  }
  return null;
}

test("replay Nov 2: lag fires on the 3rd consecutive sample over 20", () => {
  const { start, out } = incident();
  const firstOver = out.findIndex((x) => x.height - x.durableHeight > 20);
  const hit = firstAlarm(out);
  assert.ok(hit, "alarm must fire during the incident");
  assert.equal(hit.r.reason, "lag");
  assert.equal(hit.n - 1, firstOver + 2);
  const minutes = (out[hit.n - 1].ts - start) / MIN;
  assert.ok(minutes < 10, `lag alarm after ${minutes} min`);
  assert.equal(minutes, 9.75); // onset 10:28 -> alarm 10:37:45 ET
});

test("replay Nov 2: stale-only check fires at 20 minutes", () => {
  const { start, out } = incident();
  const hit = firstAlarm(out, { maxLag: Infinity });
  assert.ok(hit);
  assert.equal(hit.r.reason, "stale");
  const minutes = (out[hit.n - 1].ts - start) / MIN;
  assert.ok(minutes > 20 && minutes <= 20.75, `stale alarm after ${minutes} min`);
  assert.equal(minutes, 20.25); // first 45 s sample past 20 min: 10:48:15 ET
  // The full incident window is stale throughout once past 20 minutes.
  assert.equal(detect(out, { maxLag: Infinity }).reason, "stale");
});
