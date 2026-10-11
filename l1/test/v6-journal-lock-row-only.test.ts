// P0-03 finding reproducer: a power loss during the single lock+commit append
// (§9.1) that persists exactly the lock row (with or without its newline) and
// no byte of the commit row makes SigningJournal.open fail-stop forever
// ("Torn protocol v6 lock/commit pair"). The pair was never fsynced, so no
// commit signature was released; a cut one byte later (lock row plus a
// partial commit row) is already dropped as an unacknowledged torn tail
// (F-10). Expected (this test): the lock-row-only tail is recovered the same
// way. It FAILS on main for both cut positions.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SigningJournal } from "../src/storage.js";

const A = "a".repeat(64);

for (const [label, extra] of [["lock row with its newline", 0], ["lock row without its newline", -1], ["lock row plus one commit byte (control: passes)", 1]] as const) {
  test(`v6 journal: power loss keeping the ${label} of an unacknowledged lock+commit append is recovered on reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zyron-v6-lockrow-"));
    const path = join(directory, "signing-journal.ndjson");
    try {
      let journal = await SigningJournal.open(directory);
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
      journal.close();
      journal = await SigningJournal.open(directory);
      try {
        assert.equal(journal.v6Lock(101), null);
        assert.equal(journal.v6Row(101, 0, "commit"), undefined);
        assert.equal(journal.v6Row(101, 0, "prepare"), A);
      } finally {
        journal.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
