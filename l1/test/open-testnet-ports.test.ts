// The shared open-testnet port windows (tests and smoke) stay disjoint and
// below the ephemeral range, and the guard rejects layouts that are not.
import assert from "node:assert/strict";
import test from "node:test";
import { assertDisjointPortWindows, allocateValidatorBasePort, EPHEMERAL_PORT_FLOOR, OPEN_TESTNET_PORT_WINDOWS, VALIDATOR_PORT_OFFSETS } from "./helpers/open-testnet-ports.js";

test("open-testnet port windows are disjoint, include smoke, and stay below the ephemeral range", () => {
  assertDisjointPortWindows();
  assert.deepEqual([...OPEN_TESTNET_PORT_WINDOWS.smoke!], [19_300, 21_350]);
  for (const [lo, hi] of Object.values(OPEN_TESTNET_PORT_WINDOWS)) assert.ok(lo < hi && hi <= EPHEMERAL_PORT_FLOOR);
  assert.throws(() => assertDisjointPortWindows({ a: [13_000, 15_000], b: [14_000, 16_000] }), /overlap/);
  assert.throws(() => assertDisjointPortWindows({ a: [30_000, 33_000] }), /below 32768/);
  assert.throws(() => assertDisjointPortWindows({ a: [13_000, 13_040] }), /hold a validator block/);
});

test("allocated base ports keep the whole validator and mailbox block inside the window", async () => {
  for (const [name, [lo, hi]] of Object.entries(OPEN_TESTNET_PORT_WINDOWS)) {
    const base = await allocateValidatorBasePort(name as Parameters<typeof allocateValidatorBasePort>[0]);
    assert.ok(base >= lo && base + Math.max(...VALIDATOR_PORT_OFFSETS) < hi, `${name}: ${base}`);
    assert.equal((base - lo) % 4, 0);
  }
});
