// Round-4 independent retest (PR967 + PR979, Medium, shared root cause): the
// signing-journal tail repair dropped a trailing lock row together with a torn
// prefix of its commit row *before* replay validated that lock against the
// earlier history. A history-inconsistent lock (after a timeout at the same
// round, backwards, or conflicting with a same-round lock) was silently
// truncated instead of fail-stopping. The repair must validate first and leave
// the file untouched when the history is inconsistent.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SigningJournal } from "../src/storage.js";
const A = "a".repeat(64);
const B = "b".repeat(64);
const row = (step, round = 1, value = A, extra = {}) => JSON.stringify({ v: 2, height: 4, round, step, value, ...extra });
const lock = (round = 1, value = A) => row("lock", round, value, { lockRound: round });
const commit = (round = 1, value = A) => row("commit", round, value);
async function withJournalFile(t, contents) {
    const dir = await mkdtemp(join(tmpdir(), "zyron-journal-repair-validate-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "signing-journal.ndjson");
    await writeFile(path, contents);
    return { dir, path };
}
async function assertFailStopUntouched(t, bytes, pattern) {
    const { dir, path } = await withJournalFile(t, bytes);
    await assert.rejects(SigningJournal.open(dir), pattern);
    assert.equal(await readFile(path, "utf8"), bytes, "repair must not modify an inconsistent journal");
}
const cases = [
    ["timeout then lock at the same round", row("timeout") + "\n", lock(), commit(), /Torn|Corrupt/],
    ["backwards lock", lock(2) + "\n" + commit(2) + "\n", lock(1), commit(1), /Conflicting|Torn|Corrupt/],
    ["same-round conflicting lock", lock(1) + "\n" + commit(1) + "\n", lock(1, B), commit(1, B), /Conflicting|Torn|Corrupt/]
];
for (const [name, prior, badLock, badCommit, pattern] of cases) {
    test(`${name}: terminated pair fails stop`, async (t) => {
        await assertFailStopUntouched(t, prior + badLock + "\n" + badCommit + "\n", pattern);
    });
    for (const cutAt of [1, 30, -1]) {
        test(`${name}: lock + torn commit (${cutAt}) fails stop instead of being truncated`, async (t) => {
            const torn = badCommit.slice(0, cutAt < 0 ? badCommit.length + cutAt : cutAt);
            await assertFailStopUntouched(t, prior + badLock + "\n" + torn, pattern);
            await assertFailStopUntouched(t, prior + badLock + "\n" + torn + "\0\0", pattern);
        });
    }
}
test("a consistent lock + torn commit is still repaired (lock and tail dropped, earlier lock kept)", async (t) => {
    const prior = row("prepare", 0) + "\n" + lock(0) + "\n" + commit(0) + "\n" + row("prepare") + "\n";
    for (let n = 1; n < commit().length; n += 7) {
        const { dir, path } = await withJournalFile(t, prior + lock() + "\n" + commit().slice(0, n));
        const journal = await SigningJournal.open(dir);
        try {
            assert.deepEqual(journal.v6Lock(4), { round: 0, blockHash: A });
            assert.equal(journal.v6Row(4, 1, "commit"), undefined);
        }
        finally {
            journal.close();
        }
        assert.equal(await readFile(path, "utf8"), prior);
    }
});
