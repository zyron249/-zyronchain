import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const l1Root = process.cwd();
const shardModule = await import(pathToFileURL(join(l1Root, "scripts", "l1-test-shard.mjs")).href);
const { parseL1TestShard, selectL1TestShard, L1_TEST_SHARD_ENV } = shardModule;
async function compiledInventory() {
    const directory = join(l1Root, "dist", "test");
    return (await readdir(directory))
        .filter((name) => name.endsWith(".test.js"))
        .sort()
        .map((name) => join(directory, name));
}
test("L1 test shards: an unset or empty L1_TEST_SHARD runs the full compiled inventory", async () => {
    const files = await compiledInventory();
    assert.ok(files.length > 100, "the compiled inventory must be the real suite");
    assert.equal(L1_TEST_SHARD_ENV, "L1_TEST_SHARD");
    assert.deepEqual(selectL1TestShard(files, undefined), files);
    assert.deepEqual(selectL1TestShard(files, ""), files);
    assert.deepEqual(selectL1TestShard(files, "1/1"), files);
});
test("L1 test shards: shards 1..N partition the compiled inventory, every file exactly once", async () => {
    const files = await compiledInventory();
    for (let total = 1; total <= 4; total += 1) {
        const seen = new Map();
        const sizes = [];
        for (let index = 1; index <= total; index += 1) {
            const shard = selectL1TestShard(files, `${index}/${total}`);
            sizes.push(shard.length);
            assert.ok(shard.length > 0, `shard ${index}/${total} must not be empty`);
            for (const file of shard)
                seen.set(file, (seen.get(file) ?? 0) + 1);
        }
        assert.equal(seen.size, files.length, `shards of ${total} must cover every file`);
        for (const [file, count] of seen)
            assert.equal(count, 1, `${file} must run in exactly one of ${total} shards`);
        assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `round-robin shards of ${total} must be balanced by file count`);
    }
    // The deterministic signing-lease crash regression (a mandatory test) lands in exactly one shard of 2.
    const mandatory = files.filter((file) => file.endsWith("signing-lease-crash.test.js"));
    assert.equal(mandatory.length, 1);
    const holders = [1, 2].filter((index) => selectL1TestShard(files, `${index}/2`).includes(mandatory[0]));
    assert.equal(holders.length, 1);
});
test("L1 test shards: malformed or out-of-range shard specs are rejected instead of running a partial suite", async () => {
    const files = await compiledInventory();
    for (const spec of ["0/2", "3/2", "1/0", "2", "1/2/3", "a/2", "1/b", " 1/2", "1/2 ", "-1/2", "01/2", "1.0/2"]) {
        assert.throws(() => selectL1TestShard(files, spec), /L1_TEST_SHARD/, `spec ${JSON.stringify(spec)} must be rejected`);
    }
    assert.throws(() => selectL1TestShard(["a.test.js"], "1/2"), /more shards than/);
    assert.deepEqual(parseL1TestShard("2/3"), { index: 2, total: 3 });
    assert.equal(parseL1TestShard(undefined), null);
});
test("Miner Package CI: the non-Windows full-suite shards together cover 1..N for the N in L1_TEST_SHARD", async () => {
    const workflow = await readFile(join(l1Root, "..", ".github", "workflows", "miner-package.yml"), "utf8");
    const shardList = /^\s+shard: \[([0-9, ]+)\]$/m.exec(workflow);
    assert.ok(shardList, "matrix must declare a shard list");
    const shards = shardList[1].split(",").map((value) => Number(value.trim()));
    const env = /^\s+L1_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/([0-9]+)$/m.exec(workflow);
    assert.ok(env, "the full-suite step must pass L1_TEST_SHARD from matrix.shard");
    const total = Number(env[1]);
    assert.deepEqual(shards, Array.from({ length: total }, (_, position) => position + 1));
    // Only the Windows job (which does not run the full suite) may drop shards.
    const exclude = /^( +)exclude:\n((?:\1  .*\n)+)/m.exec(workflow);
    if (exclude) {
        const entries = exclude[2].split(/\n(?=\s+- )/).map((entry) => entry.trim()).filter(Boolean);
        for (const entry of entries) {
            assert.match(entry, /^- os: windows-2022\s+shard: [0-9]+$/, `unexpected matrix exclusion: ${entry}`);
            assert.notEqual(Number(/shard: ([0-9]+)/.exec(entry)[1]), 1, "Windows must keep one job");
        }
    }
    const step = /- name: Run full L1 regression suite on durability-capable runners\n([\s\S]*?)\n\s+- name:/.exec(workflow);
    assert.ok(step, "full-suite step must exist");
    assert.match(step[1], /if: runner\.os != 'Windows'/);
    assert.match(step[1], /L1_TEST_SHARD: \$\{\{ matrix\.shard \}\}\//);
    assert.match(step[1], /run: npm test$/m);
});
