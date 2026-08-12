import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertSigningJournalDurabilitySupported, SigningJournal } from "../src/storage.js";

const hash = (byte: string) => byte.repeat(64);

async function withDirectory(name: string, run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `zyron-${name}-`));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("validator journal durability fails closed on platforms without directory fsync", () => {
  assert.throws(
    () => assertSigningJournalDurabilitySupported("win32"),
    /requires POSIX directory fsync/
  );
  assert.doesNotThrow(() => assertSigningJournalDurabilitySupported("linux"));
  assert.doesNotThrow(() => assertSigningJournalDurabilitySupported("darwin"));
});

test("new signing journal is owner-only and can durably replay a reservation", async (context) => {
  if (process.platform === "win32") return context.skip("validator journal durability intentionally fails closed on Windows");
  await withDirectory("journal-init", async (directory) => {
    const nested = join(directory, "new", "validator", "data");
    const journal = await SigningJournal.open(nested);
    await journal.reserveAttestation(1, 0, hash("a"));
    journal.close();

    const metadata = await stat(join(nested, "signing-journal.ndjson"));
    assert.equal(metadata.mode & 0o777, 0o600);

    const reopened = await SigningJournal.open(nested);
    try {
      await assert.rejects(
        reopened.reserveSkip(1, 0, hash("b")),
        /Conflicting validator action prevented/
      );
    } finally {
      reopened.close();
    }
  });
});

test("signing journal open fails closed when initial ancestry publication is interrupted", async (context) => {
  if (process.platform === "win32") return context.skip("validator journal durability intentionally fails closed on Windows");
  await withDirectory("journal-init-fault", async (directory) => {
    const nested = join(directory, "new", "validator");
    await assert.rejects(
      SigningJournal.open(nested, {
        afterFileSync: () => { throw new Error("inject-after-file-sync"); }
      }),
      /Signing journal initialization persistence failed/
    );

    assert.equal(await readFile(join(nested, "signing-journal.ndjson"), "utf8"), "");

    const recovered = await SigningJournal.open(nested);
    try {
      await recovered.reserveAttestation(1, 0, hash("c"));
    } finally {
      recovered.close();
    }
  });
});

test("existing signing journal crosses the full directory durability boundary before open returns", async (context) => {
  if (process.platform === "win32") return context.skip("validator journal durability intentionally fails closed on Windows");
  await withDirectory("journal-existing-sync", async (directory) => {
    const initial = await SigningJournal.open(directory);
    await initial.reserveAttestation(2, 0, hash("d"));
    initial.close();

    let directorySyncBoundaryObserved = false;
    const reopened = await SigningJournal.open(directory, {
      afterDirectorySync: () => { directorySyncBoundaryObserved = true; }
    });
    try {
      assert.equal(directorySyncBoundaryObserved, true);
      await assert.rejects(
        reopened.reserveSkip(2, 0, hash("e")),
        /Conflicting validator action prevented/
      );
    } finally {
      reopened.close();
    }
  });
});
