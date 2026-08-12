import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SigningJournal } from "../src/storage.js";

const hash = (byte: string) => byte.repeat(64);

async function withJournal(
  name: string,
  run: (directory: string, journal: SigningJournal) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `zyron-${name}-`));
  let journal: SigningJournal | undefined;
  try {
    journal = await SigningJournal.open(directory);
    await run(directory, journal);
  } finally {
    journal?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function journalEntries(directory: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(directory, "signing-journal.ndjson"), "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("signing journal compaction removes only finalized slots and restart preserves future reservations", async () => {
  await withJournal("journal-compact", async (directory, journal) => {
    await journal.reserveAttestation(1, 0, hash("1"));
    await journal.reserveSkip(2, 0, hash("2"));
    await journal.reserveAttestation(3, 4, hash("3"));

    assert.equal(await journal.compactThrough(2), 2);
    assert.deepEqual(await journalEntries(directory), [
      { height: 3, round: 4, kind: "attest", value: hash("3") }
    ]);
    await assert.rejects(
      journal.reserveSkip(3, 4, hash("4")),
      /Conflicting validator action prevented/
    );

    journal.close();
    const reopened = await SigningJournal.open(directory);
    try {
      await assert.rejects(
        reopened.reserveSkip(3, 4, hash("4")),
        /Conflicting validator action prevented/
      );
      assert.equal(await reopened.compactThrough(3), 1);
      assert.deepEqual(await journalEntries(directory), []);
    } finally {
      reopened.close();
    }
  });
});

test("pre-rename compaction failure preserves old journal and fail-stops current instance", async () => {
  await withJournal("journal-pre-rename", async (directory, journal) => {
    await journal.reserveAttestation(1, 0, hash("a"));
    await journal.reserveAttestation(2, 0, hash("b"));

    await assert.rejects(
      journal.compactThrough(1, {
        afterTemporarySync: () => { throw new Error("inject-before-rename"); }
      }),
      /Signing journal compaction failed; validator restart required/
    );
    assert.equal(journal.persistenceHealthy, false);
    assert.deepEqual(await journalEntries(directory), [
      { height: 1, round: 0, kind: "attest", value: hash("a") },
      { height: 2, round: 0, kind: "attest", value: hash("b") }
    ]);
    await assert.rejects(
      journal.reserveSkip(3, 0, hash("c")),
      /Signing journal persistence fault requires validator restart/
    );

    journal.close();
    const reopened = await SigningJournal.open(directory);
    try {
      await assert.rejects(
        reopened.reserveSkip(1, 0, hash("d")),
        /Conflicting validator action prevented/
      );
      assert.equal(await reopened.compactThrough(1), 1);
    } finally {
      reopened.close();
    }
  });
});

test("post-rename compaction ambiguity fail-stops current instance and restart replays replacement", async () => {
  await withJournal("journal-post-rename", async (directory, journal) => {
    await journal.reserveAttestation(1, 0, hash("e"));
    await journal.reserveSkip(2, 1, hash("f"));

    await assert.rejects(
      journal.compactThrough(1, {
        afterRename: () => { throw new Error("inject-after-rename"); }
      }),
      /Signing journal compaction failed; validator restart required/
    );
    assert.equal(journal.persistenceHealthy, false);
    assert.deepEqual(await journalEntries(directory), [
      { height: 2, round: 1, kind: "skip", value: hash("f") }
    ]);

    journal.close();
    const reopened = await SigningJournal.open(directory);
    try {
      await assert.rejects(
        reopened.reserveAttestation(2, 1, hash("0")),
        /Conflicting validator action prevented/
      );
      assert.equal(reopened.persistenceHealthy, true);
    } finally {
      reopened.close();
    }
  });
});

test("signing journal compaction rejects invalid finalized heights", async () => {
  await withJournal("journal-invalid-height", async (_directory, journal) => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        journal.compactThrough(value),
        /Invalid signing journal compaction height/
      );
    }
  });
});
