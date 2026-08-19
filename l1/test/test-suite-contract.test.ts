import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const runnerPath = join(process.cwd(), "scripts", "test-suite.mjs");

test("canonical L1 test runner bounds each test and preserves the full compiled inventory", async () => {
  const source = await readFile(runnerPath, "utf8");

  assert.match(source, /L1_TEST_TIMEOUT_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /`--test-timeout=\$\{L1_TEST_TIMEOUT_MS\}`/);
  assert.match(source, /\.filter\(\(name\) => name\.endsWith\("\\\.test\\\.js"\)\)/);
  assert.match(source, /\.\.\.files/);
  assert.doesNotMatch(source, /--test-name-pattern/);
  assert.doesNotMatch(source, /--test-skip-pattern/);
});
