// Round-5 independent retest of #995 (R5-995-L1, Low): the signing-journal
// tail repair validated history before truncating only when the record before
// the torn tail was a v6 lock row. When any other record sat between an
// inconsistent history and the torn tail, the generic branch truncated the
// torn tail first and replay then failed stop on the inconsistent history, so
// the journal that an operator must inspect was no longer byte-identical.
// Every tail repair must validate the history it keeps before it removes
// anything; a rejected journal stays byte-for-byte unchanged.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SigningJournal } from "../src/storage.js";
const A = "a".repeat(64);
const B = "b".repeat(64);
const row = (step, round = 1, value = A, extra = {}) => JSON.stringify({ v: 2, height: 4, round, step, value, ...extra }) + "\n";
const lock = (round = 1, value = A) => row("lock", round, value, { lockRound: round });
const legacy = (height, kind, value) => JSON.stringify({ height, round: 0, kind, value }) + "\n";
async function withJournalFile(t, contents) {
    const dir = await mkdtemp(join(tmpdir(), "zyron-r5-995-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "signing-journal.ndjson");
    await writeFile(path, contents);
    return { dir, path };
}
async function quietly(run) {
    const original = console.warn;
    console.warn = () => { };
    try {
        return await run();
    }
    finally {
        console.warn = original;
    }
}
async function assertFailStopUntouched(t, bytes, pattern) {
    const { dir, path } = await withJournalFile(t, bytes);
    await quietly(() => assert.rejects(SigningJournal.open(dir), pattern));
    assert.deepEqual(await readFile(path), Buffer.from(bytes), "a rejected journal must stay byte-for-byte unchanged");
}
// Inconsistent v6 history: a lock at a round that already has a timeout.
const inconsistentV6 = row("timeout") + lock();
const middles = [
    ["a complete commit", row("commit")],
    ["a terminated partial commit", row("commit").slice(0, 30) + "\n"],
    ["a complete timeout", row("timeout", 2)],
    ["a complete prepare at a later round", row("prepare", 2)]
];
const tails = [
    ["a one-byte torn tail", "{"],
    ["a torn prefix of a valid row", row("prepare", 3).slice(0, 25)],
    ["a zero-filled torn tail", Buffer.alloc(19)]
];
for (const [middleName, middle] of middles) {
    for (const [tailName, tail] of tails) {
        test(`inconsistent v6 lock, then ${middleName}, then ${tailName}: fails stop with the bytes preserved`, async (t) => {
            const bytes = Buffer.concat([Buffer.from(inconsistentV6 + middle), Buffer.from(tail)]);
            await assertFailStopUntouched(t, bytes, /Torn|Corrupt|Conflicting/);
        });
    }
}
test("conflicting legacy reservations followed by a torn tail fail stop with the bytes preserved", async (t) => {
    const bytes = legacy(1, "attest", A) + legacy(1, "skip", B) + '{"height":2,"round":0,"kind":"att';
    await assertFailStopUntouched(t, bytes, /Conflicting signing journal history/);
});
test("mixed legacy and v6 rows at one height followed by a torn tail fail stop with the bytes preserved", async (t) => {
    const bytes = row("prepare", 0) + JSON.stringify({ height: 4, kind: "legacy" }) + "\n" + "{";
    await assertFailStopUntouched(t, bytes, /Mixed legacy and protocol v6/);
});
test("a corrupt terminated line before the last record and a torn tail fail stop with the bytes preserved", async (t) => {
    const bytes = legacy(1, "attest", A) + "not json\n" + legacy(2, "attest", A) + '{"hei';
    await assertFailStopUntouched(t, bytes, /Corrupt|JSON|Unexpected/);
});
test("a consistent history with a torn tail after a non-lock record is still repaired", async (t) => {
    const prior = row("prepare", 0) + lock(0) + row("commit", 0) + row("timeout", 1) + row("prepare", 2);
    for (const [, tail] of tails) {
        const { dir, path } = await withJournalFile(t, Buffer.concat([Buffer.from(prior), Buffer.from(tail)]));
        const journal = await quietly(() => SigningJournal.open(dir));
        try {
            assert.deepEqual(journal.v6Lock(4), { round: 0, blockHash: A });
        }
        finally {
            journal.close();
        }
        assert.equal(await readFile(path, "utf8"), prior);
    }
});
test("a consistent legacy history with a torn tail is still repaired", async (t) => {
    const prior = legacy(1, "attest", A) + legacy(2, "skip", B);
    const { dir, path } = await withJournalFile(t, prior + '{"height":3,"round":0,"kind":"att');
    const journal = await quietly(() => SigningJournal.open(dir));
    try {
        await assert.rejects(journal.reserveSkip(1, 0, B), /Conflicting validator action prevented/);
    }
    finally {
        journal.close();
    }
    assert.equal(await readFile(path, "utf8"), prior);
});
