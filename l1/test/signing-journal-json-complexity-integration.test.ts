import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SigningJournal } from "../src/storage.js";
import { SIGNING_JOURNAL_MAX_JSON_NESTING_DEPTH } from "../src/signing-journal-json-complexity.js";

test("SigningJournal rejects over-complex persisted JSON before semantic replay", {
  skip: process.platform === "win32"
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zyron-signing-json-complexity-"));
  try {
    const payload = `${"[".repeat(SIGNING_JOURNAL_MAX_JSON_NESTING_DEPTH + 1)}0${"]".repeat(SIGNING_JOURNAL_MAX_JSON_NESTING_DEPTH + 1)}\n`;
    await writeFile(join(dataDir, "signing-journal.ndjson"), payload, { mode: 0o600 });

    await assert.rejects(
      SigningJournal.open(dataDir),
      /Signing journal JSON complexity exceeded/
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
