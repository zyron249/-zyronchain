import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const legacyName = "signing journal releases its writer lease after hard crash without losing the reserved choice";
const deterministicName = "signing journal hard-crash lease uses deterministic holder liveness";

test("full suite keeps only the deterministic signing-journal hard-crash lease regression", async () => {
  const [legacySuite, deterministicSuite, runner] = await Promise.all([
    readFile(join(process.cwd(), "test", "l1.test.ts"), "utf8"),
    readFile(join(process.cwd(), "test", "signing-lease-crash.test.ts"), "utf8"),
    readFile(join(process.cwd(), "scripts", "test-suite.mjs"), "utf8")
  ]);

  assert.equal(legacySuite.includes(legacyName), false, "legacy process-racy crash test must stay removed");
  assert.equal(deterministicSuite.includes(deterministicName), true, "deterministic IPC crash test must remain mandatory");
  assert.match(runner, /Legacy process-racy signing-lease crash regression was reintroduced/);
  assert.match(runner, /Deterministic signing-lease crash regression title changed or disappeared/);
  assert.doesNotMatch(runner, /--test-name-pattern=/, "runner must not rely on a name filter to suppress the legacy test");
});
