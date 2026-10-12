// P0-03: the fault-injection invariants are not vacuous. Each mutation below
// must be reported by the harness: a validator counted as honest that signs
// without its journal, a skewed supply report, and crafted journal files
// with a double-sign, a lock regression or mixed legacy/v6 rows.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SigningJournal } from "../src/storage.js";
import { JournalAudit, runFault } from "./support/v6-fault.js";
import type { TestValidator } from "./support/consensus-harness.js";

test("P0-03 harness self-test: an 'honest' validator that votes without its journal is caught (signatures without durable rows)", { timeout: 300_000 }, async () => {
  const result = await runFault({ scenario: "byzantine-f", n: 4, seed: 2, chaosMs: 120_000, postGstHeights: 2, selfTest: "honest-voter-without-journal" });
  assert.ok(result.unjournaledSignatures.length > 0, "unjournaled signatures detected");
  assert.equal(result.ok, false);
  assert.match(result.failure ?? "", /signature without durable journal row/);
});

test("P0-03 harness self-test: a supply report that differs from initial supply minus burned fees is caught", { timeout: 300_000 }, async () => {
  const result = await runFault({ scenario: "partition-flapping", n: 4, seed: 2, chaosMs: 90_000, postGstHeights: 2, selfTest: "supply-skew" });
  assert.equal(result.supply.ok, false);
  assert.equal(result.ok, false);
  assert.match(result.failure ?? "", /supply invariant/);
});

test("P0-03 harness self-test: the journal audit flags double-signs and mixed legacy/v6 heights in a journal file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-v6fault-audit-"));
  try {
    const row = (height: number, round: number, step: string, value: string): string => `${JSON.stringify({ v: 2, height, round, step, value })}\n`;
    await writeFile(join(directory, "signing-journal.ndjson"),
      row(300, 0, "prepare", "a".repeat(64)) +
      row(300, 0, "prepare", "b".repeat(64)) +
      `${JSON.stringify({ height: 301, round: 0, kind: "attest", value: "c".repeat(64) })}\n` +
      row(301, 1, "timeout", "d".repeat(64)));
    // The real journal refuses to open this history; the audit must flag it on its own.
    await assert.rejects(SigningJournal.open(directory), /Conflicting signing journal history/);
    const audit = new JournalAudit();
    const fake = { directory, journal: { appendV6: async () => {} } } as unknown as TestValidator;
    audit.attach(0, fake);
    assert.ok(audit.violations.some((item) => item.includes("journal double-sign 300|0|prepare")), JSON.stringify(audit.violations));
    assert.deepEqual(audit.mixedHeights(), ["v0@301"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("P0-03 harness self-test: the journal audit flags a lock that moves backwards between appends", async () => {
  const audit = new JournalAudit();
  const appended: unknown[] = [];
  const directory = await mkdtemp(join(tmpdir(), "zyron-v6fault-audit-"));
  try {
    const fake = { directory, journal: { appendV6: async (rows: unknown) => { appended.push(rows); } } } as unknown as TestValidator;
    audit.attach(0, fake);
    const append = (fake.journal as unknown as { appendV6: (rows: unknown[]) => Promise<void> }).appendV6;
    await append([{ v: 2, height: 400, round: 2, step: "lock", value: "a".repeat(64), lockRound: 2 }, { v: 2, height: 400, round: 2, step: "commit", value: "a".repeat(64) }]);
    await append([{ v: 2, height: 400, round: 1, step: "lock", value: "b".repeat(64), lockRound: 1 }, { v: 2, height: 400, round: 1, step: "commit", value: "b".repeat(64) }]);
    assert.ok(audit.violations.some((item) => item.includes("lock regression at 400")), JSON.stringify(audit.violations));
    assert.equal(appended.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
