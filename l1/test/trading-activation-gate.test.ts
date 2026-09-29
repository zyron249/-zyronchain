import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("real-money trading preflight fails closed while launch gates are incomplete", () => {
  const result = spawnSync(process.execPath, [
    "scripts/verify-trading-activation.mjs",
    "../docs/fixed-supply-launch-plan.json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });

  assert.equal(result.status, 2);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /activation REFUSED/);
  assert.match(output, /founder vesting is not consensus-enforced/);
  assert.match(output, /quote asset is not frozen/);
  assert.match(output, /website trading is not activated/);
});
