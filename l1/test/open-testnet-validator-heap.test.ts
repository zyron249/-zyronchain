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
  assert.ok(api.VALIDATOR_MAX_OLD_MB_DEFAULT >= 48 && api.VALIDATOR_MAX_OLD_MB_DEFAULT <= 96);
});

test("ZYRON_VALIDATOR_MAX_OLD_MB overrides the cap, and 0 disables it", () => {
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "96" }), ["--max-old-space-size=96"]);
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "0" }), []);
});

test("invalid or out-of-range values fall back to the default", () => {
  for (const raw of ["abc", "-5", "8", "12.5", "100000", "64; rm"]) {
    assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: raw }), [`--max-old-space-size=${api.VALIDATOR_MAX_OLD_MB_DEFAULT}`], raw);
  }
});
