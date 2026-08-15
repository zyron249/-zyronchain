import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

interface ResumeScaleOutput {
  accounts: number;
  prepared: { root: string; records: number; keys: number };
  staged: {
    root: string;
    records: number;
    keys: number;
    stageMs: number;
    heapDeltaMiB: number;
    rssMiB: number;
    maxRssMiB: number;
  };
}

test("State-v2 resume scale benchmark executes the bounded staging path", () => {
  const stdout = execFileSync(process.execPath, ["dist/bench/state-v2-resume-scale.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ZYRON_RESUME_SCALE_ACCOUNTS: "64" },
    maxBuffer: 4 * 1024 * 1024
  });
  const value = JSON.parse(stdout) as ResumeScaleOutput;
  assert.equal(value.accounts, 64);
  assert.match(value.prepared.root, /^[0-9a-f]{64}$/);
  assert.equal(value.staged.root, value.prepared.root);
  assert.equal(value.staged.records, value.prepared.records);
  assert.equal(value.staged.keys, value.prepared.keys);
  assert.ok(value.staged.records > 0);
  assert.ok(value.staged.keys > 0);
  assert.ok(Number.isFinite(value.staged.stageMs) && value.staged.stageMs >= 0);
  assert.ok(Number.isFinite(value.staged.heapDeltaMiB));
  assert.ok(Number.isFinite(value.staged.rssMiB) && value.staged.rssMiB > 0);
  assert.ok(Number.isFinite(value.staged.maxRssMiB) && value.staged.maxRssMiB > 0);
});
