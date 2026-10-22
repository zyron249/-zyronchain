// P0-03 finding: a power loss during the single lock+commit append (section
// 9.1) that persists exactly the lock row (with or without its newline) and no
// byte of the commit row made SigningJournal.open fail-stop forever ("Torn
// protocol v6 lock/commit pair"), a liveness loss with no sanctioned recovery
// (journals must never be hand-edited). The fix keeps the lock and completes
// the pair with the matching commit reservation: nothing that might have been
// signed is forgotten, so no conflicting vote becomes possible. A cut one byte
// later (lock row plus a partial commit row) stays an unacknowledged torn tail
// that is dropped whole (F-10).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SigningJournal } from "../src/storage.js";
const A = "a".repeat(64);
const B = "b".repeat(64);
const prepareLine = `${JSON.stringify({ v: 2, height: 101, round: 0, step: "prepare", value: A })}\n`;
const lockLine = `${JSON.stringify({ v: 2, height: 101, round: 0, step: "lock", value: A, lockRound: 0 })}\n`;
const commitLine = `${JSON.stringify({ v: 2, height: 101, round: 0, step: "commit", value: A })}\n`;
async function tornCommitAppend(directory, extra) {
    const path = join(directory, "signing-journal.ndjson");
    const journal = await SigningJournal.open(directory);
    try {
        await journal.reserveV6Prepare(101, 0, A, -1);
        const before = (await stat(path)).size;
        await assert.rejects(journal.reserveV6Commit(101, 0, A, {
            afterWrite: async () => {
                const appended = (await readFile(path)).subarray(before);
                const lockRow = appended.indexOf(0x0a) + 1;
                await truncate(path, before + lockRow + extra); // power loss before fsync
                throw new Error("simulated power loss");
            }
        }), /persistence failed/);
    }
    finally {
        journal.close();
    }
}
for (const [label, extra] of [["lock row with its newline", 0], ["lock row without its newline", -1]]) {
    test(`v6 journal: power loss keeping the ${label} of an unacknowledged lock+commit append keeps the lock and completes the pair`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "zyron-v6-lockrow-"));
        const path = join(directory, "signing-journal.ndjson");
        try {
            await tornCommitAppend(directory, extra);
            let journal = await SigningJournal.open(directory);
            try {
                assert.deepEqual(journal.v6Lock(101), { round: 0, blockHash: A }, "the lock is never forgotten");
                assert.equal(journal.v6Row(101, 0, "commit"), A, "the commit reservation is completed");
                assert.equal(journal.v6Row(101, 0, "prepare"), A);
                assert.equal(journal.v6Rounds(101).maxVoteRound, 0);
                // No conflicting vote is possible for the locked round.
                await assert.rejects(journal.reserveV6Commit(101, 0, B), /Conflicting validator action prevented/);
                await assert.rejects(journal.reserveV6Prepare(101, 0, B, -1), /Conflicting validator action prevented|differs|lock/);
                // Re-signing the same commit is idempotent (deterministic signature).
                await journal.reserveV6Commit(101, 0, A);
            }
            finally {
                journal.close();
            }
            assert.equal(await readFile(path, "utf8"), `${prepareLine}${lockLine}${commitLine}`, "the journal is a well-framed complete pair");
            journal = await SigningJournal.open(directory); // stable on the next restart
            try {
                assert.deepEqual(journal.v6Lock(101), { round: 0, blockHash: A });
                await journal.reserveV6(101, 1, "timeout", A);
            }
            finally {
                journal.close();
            }
            assert.equal(await readFile(path, "utf8"), `${prepareLine}${lockLine}${commitLine}${JSON.stringify({ v: 2, height: 101, round: 1, step: "timeout", value: A })}\n`);
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
}
test("v6 journal: power loss keeping the lock row plus one commit byte is still dropped whole as a torn tail (F-10)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zyron-v6-lockrow-"));
    try {
        await tornCommitAppend(directory, 1);
        const journal = await SigningJournal.open(directory);
        try {
            assert.equal(journal.v6Lock(101), null);
            assert.equal(journal.v6Row(101, 0, "commit"), undefined);
            assert.equal(journal.v6Row(101, 0, "prepare"), A);
        }
        finally {
            journal.close();
        }
        assert.equal(await readFile(join(directory, "signing-journal.ndjson"), "utf8"), prepareLine);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test("v6 journal: a crash during the lone-lock completion write is recovered on the next open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zyron-v6-lockrow-"));
    const path = join(directory, "signing-journal.ndjson");
    try {
        await tornCommitAppend(directory, 0);
        // Crash before the completion write is fsynced, leaving the lone lock.
        const sizeBefore = (await stat(path)).size;
        await assert.rejects(SigningJournal.open(directory, {
            afterTailRepairWrite: async () => {
                await truncate(path, sizeBefore);
                throw new Error("simulated crash");
            }
        }), /simulated crash/);
        const journal = await SigningJournal.open(directory);
        try {
            assert.deepEqual(journal.v6Lock(101), { round: 0, blockHash: A });
            assert.equal(journal.v6Row(101, 0, "commit"), A);
        }
        finally {
            journal.close();
        }
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
