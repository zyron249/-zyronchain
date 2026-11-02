// Validators are started with a bounded V8 old generation so their RSS does
// not creep up on the 512 MB open-testnet host.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);

test("validators get the default old-space cap", () => {
  assert.deepEqual(api.validatorNodeFlags({}), [`--max-old-space-size=${api.VALIDATOR_MAX_OLD_MB_DEFAULT}`]);
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "" }), [`--max-old-space-size=${api.VALIDATOR_MAX_OLD_MB_DEFAULT}`]);
  // Measured live heap is ~27 MB; the cap must stay well under the 512 MB host.
  assert.ok(api.VALIDATOR_MAX_OLD_MB_DEFAULT === 96);
});

test("ZYRON_VALIDATOR_MAX_OLD_MB overrides the cap, and 0 disables it", () => {
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "96" }), ["--max-old-space-size=96"]);
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "0" }), []);
});

test("invalid or out-of-range values fall back to the default", () => {
  for (const raw of ["abc", "-5", "8", "31", "4097", "12.5", "100000", "64; rm", " 96", "96 ", "+96", "0x60", "1e2", "96MB", "١٢٣"]) {
    assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: raw }), [`--max-old-space-size=${api.VALIDATOR_MAX_OLD_MB_DEFAULT}`], raw);
  }
});

test("the 32..4096 bounds are inclusive and leading zeros are digits", () => {
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "32" }), ["--max-old-space-size=32"]);
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "4096" }), ["--max-old-space-size=4096"]);
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "064" }), ["--max-old-space-size=64"]);
});

function clock(start = 1_000_000) { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; }

test("restart backoff doubles from 5 s to a 5 min cap", () => {
  const c = clock(); const sup = api.createValidatorSupervisor({ now: c.now });
  const delays: number[] = [];
  for (let i = 0; i < 9; i++) { sup.started("v1"); c.advance(1_000); delays.push(sup.exited("v1", { code: 1, signal: null })); sup.restarting("v1"); }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  assert.equal(sup.status("v1").restarts, 9);
});

test("backoff resets after a stable run of 10 min, the restart count does not", () => {
  const c = clock(); const sup = api.createValidatorSupervisor({ now: c.now });
  for (let i = 0; i < 3; i++) { sup.started("v2"); c.advance(1_000); sup.exited("v2", { code: 1 }); sup.restarting("v2"); }
  sup.started("v2"); c.advance(api.VALIDATOR_RESTART_STABLE_MS - 1);
  assert.equal(sup.exited("v2", { code: 1 }), 40_000);
  sup.restarting("v2"); sup.started("v2"); c.advance(api.VALIDATOR_RESTART_STABLE_MS);
  assert.equal(sup.exited("v2", { code: 1 }), 5_000);
  assert.equal(sup.status("v2").restarts, 4);
});

test("restart counts are per validator", () => {
  const c = clock(); const sup = api.createValidatorSupervisor({ now: c.now });
  sup.started("v1"); sup.exited("v1", { code: 1 }); sup.restarting("v1");
  assert.equal(sup.status("v1").restarts, 1);
  assert.deepEqual(sup.status("v3"), { restarts: 0, lastExitCode: null, lastExitSignal: null, lastExitAt: null, lastExitReason: null });
  sup.started("v3"); c.advance(10);
  assert.equal(sup.exited("v3", { code: 1 }), 5_000);
});

test("exit reasons: SIGABRT (V8 heap OOM) is oom, other signals are signal, codes are exit", () => {
  assert.equal(api.classifyValidatorExit(null, "SIGABRT"), "oom");
  assert.equal(api.classifyValidatorExit(134, null), "oom");
  assert.equal(api.classifyValidatorExit(null, "SIGKILL"), "signal");
  assert.equal(api.classifyValidatorExit(1, null), "exit");
  assert.equal(api.classifyValidatorExit(0, null), "exit");
});

test("/health validator entries carry restarts and the last exit, labelled oom for SIGABRT", () => {
  const c = clock(Date.UTC(2026, 10, 2, 16, 0, 0)); const sup = api.createValidatorSupervisor({ now: c.now });
  sup.started("v1"); c.advance(2_000); sup.exited("v1", { code: null, signal: "SIGABRT" }); sup.restarting("v1");
  sup.started("v2"); c.advance(1_000); sup.exited("v2", { code: 1, signal: null }); sup.restarting("v2");
  const out = api.withSupervisorStatus([{ name: "v1", up: true, height: 5 }, { name: "v2", up: false }, { name: "v3", up: true }], sup);
  assert.deepEqual(out[0], { name: "v1", up: true, height: 5, restarts: 1, lastExitCode: null, lastExitSignal: "SIGABRT", lastExitAt: "2026-11-02T16:00:02.000Z", lastExitReason: "oom" });
  assert.equal(out[1].lastExitReason, "exit"); assert.equal(out[1].lastExitCode, 1); assert.equal(out[1].restarts, 1);
  assert.equal(out[2].restarts, 0); assert.equal(out[2].lastExitReason, null);
});
