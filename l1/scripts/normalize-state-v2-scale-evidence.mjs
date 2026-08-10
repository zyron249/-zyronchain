#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function finiteNonNegative(value, label) {
  assert.equal(typeof value, "number", `${label} must be a number`);
  assert.ok(Number.isFinite(value) && value >= 0, `${label} must be finite and non-negative`);
}

const resultPath = option("--result");
const outputPath = option("--out");
const expectedAccounts = Number(option("--accounts"));
assert.ok(Number.isSafeInteger(expectedAccounts) && expectedAccounts >= 100_000 && expectedAccounts <= 1_000_000,
  "--accounts must be a safe integer between 100000 and 1000000");

const raw = JSON.parse(await readFile(resultPath, "utf8"));
assert.equal(raw.accounts, expectedAccounts, "Scale benchmark account count mismatch");
for (const section of ["setup", "firstRestart", "gc", "secondRestart"]) {
  assert.ok(raw[section] && typeof raw[section] === "object" && !Array.isArray(raw[section]), `Missing ${section}`);
}

const root = raw.setup.root;
assert.match(root, /^[0-9a-f]{64}$/, "Invalid authenticated State-v2 root");
assert.equal(raw.firstRestart.root, root, "First restart root mismatch");
assert.equal(raw.gc.root, root, "GC root mismatch");
assert.equal(raw.secondRestart.root, root, "Second restart root mismatch");
assert.ok(Number.isSafeInteger(raw.setup.nodes) && raw.setup.nodes > expectedAccounts, "Scale setup node count is implausible");
assert.ok(Number.isSafeInteger(raw.setup.semanticKeys) && raw.setup.semanticKeys >= expectedAccounts, "Scale semantic-key count is incomplete");
assert.ok(Number.isSafeInteger(raw.gc.removedNodes) && raw.gc.removedNodes > 0, "Scale GC removed no historical nodes");
assert.ok(Number.isSafeInteger(raw.gc.beforeNodes) && Number.isSafeInteger(raw.gc.afterNodes) && raw.gc.afterNodes < raw.gc.beforeNodes,
  "Scale GC did not reduce historical node count");
for (const restart of [raw.firstRestart, raw.secondRestart]) {
  assert.ok(Number.isSafeInteger(restart.residentCacheRecords) && restart.residentCacheRecords <= 4_096,
    "Scale restart exceeded the State-v2 resolver cache bound");
  finiteNonNegative(restart.restartMs, "restartMs");
  finiteNonNegative(restart.rssMiB, "rssMiB");
}
finiteNonNegative(raw.setup.setupMs, "setupMs");
finiteNonNegative(raw.gc.gcMs, "gcMs");
assert.ok(Number.isSafeInteger(raw.sqliteBytes) && raw.sqliteBytes > 0, "Invalid State-v2 SQLite size");

const evidence = {
  status: "ok",
  scenario: "state-v2-large-cardinality-regression",
  accounts: expectedAccounts,
  authenticatedRoot: root,
  measurementsAreCiRegressionEvidenceOnly: true,
  targetHardwareGateClosed: false,
  result: raw
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o644 });
