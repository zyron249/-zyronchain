// F-10 residual (independent retest, round 2): the signing-journal tail
// repair drops a terminated v6 lock row together with a torn commit row,
// because both belong to one fsynced append that was never acknowledged.
// It must do so only when the lock row is exactly a row this binary writes
// and the torn tail is the beginning of that lock's own commit row (optionally
// followed by zero fill). Anything else is corruption before the tail and must
// fail stop without modifying the file.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SigningJournal } from "../src/storage.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const JOURNAL = "signing-journal.ndjson";

const prepare = JSON.stringify({ v: 2, height: 4, round: 1, step: "prepare", value: A });
const lock = JSON.stringify({ v: 2, height: 4, round: 1, step: "lock", value: A, lockRound: 1 });
const commit = JSON.stringify({ v: 2, height: 4, round: 1, step: "commit", value: A });

async function withJournalFile(contents: string | Buffer, run: (directory: string, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zyron-f10-lock-repair-"));
  try {
    const path = join(directory, JOURNAL);
    await writeFile(path, contents);
    await run(directory, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function openQuietly(directory: string): Promise<SigningJournal> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await SigningJournal.open(directory);
  } finally {
    console.warn = original;
  }
}

test("F-10: a corrupt terminated lock row before a torn tail fails stop and the file is not modified", async () => {
  const cases: Array<[string, string]> = [
    ["lockRound inconsistent with round", JSON.stringify({ v: 2, height: 4, round: 1, step: "lock", value: A, lockRound: 99 })],
    ["non-hex value", JSON.stringify({ v: 2, height: 4, round: 1, step: "lock", value: "z".repeat(64), lockRound: 1 })],
    ["extra key", JSON.stringify({ v: 2, height: 4, round: 1, step: "lock", value: A, lockRound: 1, extra: 1 })],
    ["non-canonical key order", JSON.stringify({ v: 2, round: 1, height: 4, step: "lock", value: A, lockRound: 1 })]
  ];
  for (const [name, corruptLock] of cases) {
    const contents = `${prepare}\n${corruptLock}\n${commit.slice(0, 30)}`;
    await withJournalFile(contents, async (directory, path) => {
      await assert.rejects(() => openQuietly(directory), /Corrupt|Torn|Conflicting/, name);
      assert.equal(await readFile(path, "utf8"), contents, `${name}: the journal must be left untouched for forensics`);
    });
  }
});

test("F-10: a torn tail that is not the beginning of the lock's own commit row fails stop", async () => {
  const cases: Array<[string, string]> = [
    ["commit for another block", JSON.stringify({ v: 2, height: 4, round: 1, step: "commit", value: B }).slice(0, 70)],
    ["commit for another round", JSON.stringify({ v: 2, height: 4, round: 2, step: "commit", value: A }).slice(0, 40)],
    ["a different step", JSON.stringify({ v: 2, height: 4, round: 1, step: "timeout", value: A }).slice(0, 45)],
    ["garbage", "{not a journal row"]
  ];
  for (const [name, tail] of cases) {
    const contents = `${prepare}\n${lock}\n${tail}`;
    await withJournalFile(contents, async (directory, path) => {
      await assert.rejects(() => openQuietly(directory), /Corrupt|Torn|Conflicting/, name);
      assert.equal(await readFile(path, "utf8"), contents, `${name}: the journal must be left untouched for forensics`);
    });
  }
});

test("F-10: a genuinely torn lock/commit append is still dropped whole (prefix, zero fill, prefix plus zero fill)", async () => {
  const tails: Array<[string, Buffer]> = [
    ["commit prefix", Buffer.from(commit.slice(0, 30))],
    ["single byte of the commit", Buffer.from(commit.slice(0, 1))],
    ["commit without its closing brace", Buffer.from(commit.slice(0, -1))],
    ["zero fill", Buffer.alloc(40)],
    ["commit prefix then zero fill", Buffer.concat([Buffer.from(commit.slice(0, 25)), Buffer.alloc(40)])]
  ];
  for (const [name, tail] of tails) {
    await withJournalFile(Buffer.concat([Buffer.from(`${prepare}\n${lock}\n`), tail]), async (directory, path) => {
      const journal = await openQuietly(directory);
      try {
        assert.equal(journal.v6Lock(4), null, `${name}: no lock from an unacknowledged append`);
        assert.equal(journal.v6Row(4, 1, "prepare"), A, name);
      } finally {
        journal.close();
      }
      assert.equal(await readFile(path, "utf8"), `${prepare}\n`, name);
    });
  }
});
