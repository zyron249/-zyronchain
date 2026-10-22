import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const runnerPath = join(process.cwd(), "scripts", "test-suite.mjs");
test("canonical L1 test runner bounds each test and preserves the full compiled inventory", async () => {
    const source = await readFile(runnerPath, "utf8");
    assert.match(source, /L1_TEST_TIMEOUT_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
    assert.match(source, /`--test-timeout=\$\{L1_TEST_TIMEOUT_MS\}`/);
    assert.ok(source.includes('.filter((name) => name.endsWith(".test.js"))'));
    // The full inventory is filtered only by the round-robin shard helper, driven
    // only by L1_TEST_SHARD (unset = every file; see l1-test-shard.test.ts).
    assert.match(source, /const shardSpec = process\.env\[L1_TEST_SHARD_ENV\];/);
    assert.match(source, /const shardFiles = selectL1TestShard\(files, shardSpec\);/);
    assert.match(source, /\.\.\.shardFiles\n/);
    assert.equal((source.match(/selectL1TestShard\(/g) ?? []).length, 1);
    assert.doesNotMatch(source, /files\.(?:slice|splice|filter\((?!\(name\)))/);
    assert.doesNotMatch(source, /--test-name-pattern/);
    assert.doesNotMatch(source, /--test-skip-pattern/);
});
