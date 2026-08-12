import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SigningJournal } from "../src/storage.js";

const hash = (byte: string) => byte.repeat(64);

async function withDirectory(name: string, run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `zyron-${name}-`));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("new signing journal is owner-only and can durably replay a reservation", async () => {
  await withDirectory("journal-init", async (directory) => {
    const journal = await SigningJournal.open(directory);
    await journal.reserveAttestation(1, 0, hash("a"));
    journal.close();

    if (process.platform !== "win32") {
      const metadata = await stat(join(directory, "signing-journal.ndjson"));
      assert.equal(metadata.mode & 0o777, 0o600);
    }

    const reopened = await SigningJournal.open(directory);
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

test("signing journal open fails closed when initial directory publication is interrupted", async () => {
  await withDirectory("journal-init-fault", async (directory) => {
    await assert.rejects(
      SigningJournal.open(directory, {
        afterFileSync: () => { throw new Error("inject-after-file-sync"); }
      }),
      /Signing journal initialization persistence failed/
    );

    assert.equal(await readFile(join(directory, "signing-journal.ndjson"), "utf8"), "");

    const recovered = await SigningJournal.open(directory);
    try {
      await recovered.reserveAttestation(1, 0, hash("c"));
    } finally {
      recovered.close();
    }
  });
});

test("existing signing journal is directory-synced before open returns", async () => {
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
