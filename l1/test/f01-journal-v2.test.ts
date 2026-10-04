// F-01 phase 2: signing journal row format v2 (spec §6, §9) and the v6
// consensus-state files. Covers T10 (migration, downgrade, torn pair) and the
// journal half of T5 (restart while locked, crash points around the lock).
import assert from "node:assert/strict";
import test from "node:test";
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConsensusStateStore } from "../src/consensus-state-store.js";
import { SigningJournal } from "../src/storage.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

async function withDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zyron-f01-journal-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function rows(directory: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(directory, "signing-journal.ndjson"), "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Exact replay predicate of the base binary (8a07c0c, storage.ts:817-820),
// i.e. what a node without v6 support does with each journal line.
function legacyBinaryAccepts(row: Record<string, unknown>): boolean {
  return Number.isSafeInteger(row.height) && Number.isSafeInteger(row.round) &&
    (row.kind === "attest" || row.kind === "skip") &&
    typeof row.value === "string" && /^[0-9a-f]{64}$/.test(row.value);
}

test("journal v2: §6.2 forbidden combinations are refused before any row is written", async () => {
  await withDir(async (directory) => {
    const journal = await SigningJournal.open(directory);
    try {
      // Rule 1: one value per (H, r, step); identical re-reservation is idempotent.
      await journal.reserveV6Prepare(10, 0, A, -1);
      await journal.reserveV6Prepare(10, 0, A, -1);
      await assert.rejects(() => journal.reserveV6Prepare(10, 0, B, -1), /Conflicting validator action/);
      await journal.reserveV6(10, 0, "proposal", C);
      await assert.rejects(() => journal.reserveV6(10, 0, "proposal", A), /Conflicting validator action/);
      // Rule 3: commit must match the own prepare of that round.
      await assert.rejects(() => journal.reserveV6Commit(10, 0, B), /differs from own prepare/);
      await journal.reserveV6Commit(10, 0, A);
      await journal.reserveV6Commit(10, 0, A); // idempotent
      assert.deepEqual(journal.v6Lock(10), { round: 0, blockHash: A });
      // §6.3: a timeout after prepare and commit in the same round is legal.
      await journal.reserveV6(10, 0, "timeout", C);
      await assert.rejects(() => journal.reserveV6(10, 0, "timeout", A), /Conflicting validator action/);
      // Rule 2: nothing more at r <= timed-out round.
      await assert.rejects(() => journal.reserveV6Commit(10, 0, B), /Conflicting|timed out/);
      await assert.rejects(() => journal.reserveV6(10, 0, "block-proposal", B), /timed out/);
      // Rule 4: SAFE-VOTE against the persisted lock (0, A).
      await assert.rejects(() => journal.reserveV6Prepare(10, 1, B, -1), /conflicts with the validator's lock/);
      await assert.rejects(() => journal.reserveV6Prepare(10, 1, B, 0), /Invalid v6 justify round|conflicts/);
      await journal.reserveV6Prepare(10, 1, A, -1); // same value
      await journal.reserveV6Prepare(10, 2, B, 1); // strictly higher justification unlocks
      // Rule 2: no vote at a round below an existing vote.
      await assert.rejects(() => journal.reserveV6(10, 1, "proposal", B), /later round was already voted/);
      // Rule 5: the lock never moves backwards (commit at 1 after prepare at 2 is refused by rule 2 first).
      await assert.rejects(() => journal.reserveV6Commit(10, 1, A), /later round|lock may not move/);
      await journal.reserveV6Commit(10, 2, B);
      assert.deepEqual(journal.v6Lock(10), { round: 2, blockHash: B });
      assert.deepEqual(journal.v6Rounds(10), { maxVoteRound: 2, maxTimeoutRound: 0 });
      // Invalid justify rounds and slots.
      await assert.rejects(() => journal.reserveV6Prepare(10, 3, B, 3), /Invalid v6 justify round/);
      await assert.rejects(() => journal.reserveV6Prepare(10, -1, B, -1), /Invalid signing slot/);
      await assert.rejects(() => journal.reserveV6Prepare(10, 3, "zz", -1), /Invalid signing hash/);
    } finally {
      journal.close();
    }
  });
});

test("journal v2: the lock and commit rows are one append, rows carry no kind key, and the base binary refuses them (T10 downgrade)", async () => {
  await withDir(async (directory) => {
    const journal = await SigningJournal.open(directory);
    await journal.reserveV6Prepare(5, 3, A, -1);
    let writes = 0;
    await journal.reserveV6Commit(5, 3, A, { afterWrite: () => { writes += 1; } });
    journal.close();
    assert.equal(writes, 1, "lock and commit must be written by a single append");
    const lines = await rows(directory);
    assert.deepEqual(lines, [
      { v: 2, height: 5, round: 3, step: "prepare", value: A },
      { v: 2, height: 5, round: 3, step: "lock", value: A, lockRound: 3 },
      { v: 2, height: 5, round: 3, step: "commit", value: A }
    ]);
    for (const row of lines) {
      assert.equal(Object.hasOwn(row, "kind"), false);
      assert.equal(legacyBinaryAccepts(row), false, "an old binary must fail closed on v2 rows");
    }
    // The guard depends on the missing kind key: with one, the old binary would silently accept the row.
    assert.equal(legacyBinaryAccepts({ ...lines[0], kind: "attest" }), true);
    // Line bounds of §9.2.
    const text = await readFile(join(directory, "signing-journal.ndjson"), "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      assert.ok(Buffer.byteLength(line) <= 1_024);
      assert.ok((line.match(/[{}[\],:]/g) ?? []).length <= 128);
    }
  });
});

test("journal v2: restart while locked restores lock, rows and refusals; legacy rows replay unchanged (T5/T10)", async () => {
  await withDir(async (directory) => {
    // A legacy journal from a v1-v5 node, then v6 rows at later heights.
    await writeFile(join(directory, "signing-journal.ndjson"),
      `${JSON.stringify({ height: 1, round: 0, kind: "attest", value: A })}\n${JSON.stringify({ height: 2, round: 1, kind: "skip", value: B })}\n`);
    let journal = await SigningJournal.open(directory);
    await journal.reserveV6Prepare(3, 0, A, -1);
    await journal.reserveV6Commit(3, 0, A);
    await journal.reserveV6(3, 0, "timeout", C);
    journal.close();
    journal = await SigningJournal.open(directory);
    try {
      assert.deepEqual(journal.v6Lock(3), { round: 0, blockHash: A });
      assert.deepEqual(journal.v6Rounds(3), { maxVoteRound: 0, maxTimeoutRound: 0 });
      assert.equal(journal.v6Row(3, 0, "timeout"), C);
      await assert.rejects(() => journal.reserveV6Prepare(3, 1, B, -1), /conflicts with the validator's lock/);
      await assert.rejects(() => journal.reserveV6(3, 0, "timeout", A), /Conflicting/);
      // Legacy rows are still enforced exactly as before.
      await journal.reserveAttestation(1, 0, A);
      await assert.rejects(() => journal.reserveSkip(1, 0, B), /Conflicting validator action/);
      await assert.rejects(() => journal.reserveAttestation(2, 1, A), /Conflicting validator action/);
      assert.equal(journal.hasLegacyRows(1), true);
      assert.equal(journal.hasV6Rows(3), true);
    } finally {
      journal.close();
    }
  });
});

test("journal v2: legacy and v6 rows never mix at one height (§6.2-7), live and on replay", async () => {
  await withDir(async (directory) => {
    const journal = await SigningJournal.open(directory);
    try {
      await journal.reserveAttestation(7, 0, A);
      await assert.rejects(() => journal.reserveV6Prepare(7, 1, A, -1), /legacy journal rows exist/);
      await assert.rejects(() => journal.reserveV6(7, 1, "timeout", A), /legacy journal rows exist/);
      await journal.reserveV6Prepare(8, 0, A, -1);
      await assert.rejects(() => journal.reserveSkip(8, 1, B), /protocol v6 journal rows exist/);
      await assert.rejects(() => journal.reserveAttestation(8, 0, A), /protocol v6 journal rows exist/);
    } finally {
      journal.close();
    }
  });
  await withDir(async (directory) => {
    await writeFile(join(directory, "signing-journal.ndjson"),
      `${JSON.stringify({ v: 2, height: 9, round: 0, step: "prepare", value: A })}\n${JSON.stringify({ height: 9, round: 1, kind: "skip", value: B })}\n`);
    await assert.rejects(() => SigningJournal.open(directory), /Mixed legacy and protocol v6/);
  });
});

test("journal v2: a torn lock/commit pair or a malformed v2 row fails stop on open (T10)", async () => {
  const lock = JSON.stringify({ v: 2, height: 4, round: 1, step: "lock", value: A, lockRound: 1 });
  const commit = JSON.stringify({ v: 2, height: 4, round: 1, step: "commit", value: A });
  const cases: Array<[string, string, RegExp]> = [
    ["lock without commit", `${lock}\n`, /Torn protocol v6 lock\/commit pair/],
    ["lock with a truncated commit", `${lock}\n${commit.slice(0, 30)}`, /Corrupt|JSON|Unexpected/],
    ["lock followed by another row", `${lock}\n${JSON.stringify({ v: 2, height: 4, round: 1, step: "timeout", value: A })}\n`, /Torn/],
    ["commit for a different value", `${lock}\n${JSON.stringify({ v: 2, height: 4, round: 1, step: "commit", value: B })}\n`, /Torn/],
    ["lockRound mismatch", `${JSON.stringify({ v: 2, height: 4, round: 1, step: "lock", value: A, lockRound: 0 })}\n${commit}\n`, /Corrupt signing journal entry/],
    ["unknown step", `${JSON.stringify({ v: 2, height: 4, round: 1, step: "attest", value: A })}\n`, /Corrupt signing journal entry/],
    ["kind key on a v2 row", `${JSON.stringify({ v: 2, height: 4, round: 1, step: "prepare", value: A, kind: "attest" })}\n`, /Corrupt signing journal entry/],
    ["conflicting v2 history", `${JSON.stringify({ v: 2, height: 4, round: 1, step: "prepare", value: A })}\n${JSON.stringify({ v: 2, height: 4, round: 1, step: "prepare", value: B })}\n`, /Conflicting signing journal history/],
    ["lock moving backwards", `${lock}\n${commit}\n${JSON.stringify({ v: 2, height: 4, round: 0, step: "lock", value: B, lockRound: 0 })}\n${JSON.stringify({ v: 2, height: 4, round: 0, step: "commit", value: B })}\n`, /Conflicting signing journal history/]
  ];
  for (const [name, contents, pattern] of cases) {
    await withDir(async (directory) => {
      await writeFile(join(directory, "signing-journal.ndjson"), contents);
      await assert.rejects(() => SigningJournal.open(directory), pattern, name);
    });
  }
  await withDir(async (directory) => {
    await writeFile(join(directory, "signing-journal.ndjson"), `${lock}\n${commit}\n`);
    const journal = await SigningJournal.open(directory);
    assert.deepEqual(journal.v6Lock(4), { round: 1, blockHash: A });
    journal.close();
  });
});

test("journal v2: crash points around the lock leave no lock (never signed) or a complete lock (T5)", async () => {
  // Crash after the append but before fsync returns: the instance fail-stops,
  // the caller never signs, and replay sees either nothing or the full pair.
  await withDir(async (directory) => {
    const journal = await SigningJournal.open(directory);
    await journal.reserveV6Prepare(6, 0, A, -1);
    await assert.rejects(
      () => journal.reserveV6Commit(6, 0, A, { afterWrite: () => { throw new Error("simulated crash before fsync"); } }),
      /persistence failed; validator restart required/
    );
    assert.equal(journal.persistenceHealthy, false);
    await assert.rejects(() => journal.reserveV6(6, 0, "timeout", C), /persistence fault requires validator restart/);
    journal.close();
    const reopened = await SigningJournal.open(directory);
    assert.deepEqual(reopened.v6Lock(6), { round: 0, blockHash: A }, "the single append landed completely");
    await assert.rejects(() => reopened.reserveV6Prepare(6, 1, B, -1), /lock/);
    reopened.close();
  });
  // A crash that lost the append entirely: no lock and no commit row, nothing was signed.
  await withDir(async (directory) => {
    await writeFile(join(directory, "signing-journal.ndjson"), `${JSON.stringify({ v: 2, height: 6, round: 0, step: "prepare", value: A })}\n`);
    const journal = await SigningJournal.open(directory);
    assert.equal(journal.v6Lock(6), null);
    assert.equal(journal.v6Row(6, 0, "commit"), undefined);
    journal.close();
  });
});

test("journal v2: compaction keeps later v2 rows in order, drops finalized ones and their consensus-state files", async () => {
  await withDir(async (directory) => {
    const journal = await SigningJournal.open(directory);
    await journal.reserveV6Prepare(20, 0, A, -1);
    await journal.reserveV6Commit(20, 0, A);
    await journal.reserveV6Prepare(21, 0, B, -1);
    await journal.reserveV6Commit(21, 0, B);
    await journal.reserveV6(21, 0, "timeout", C);
    await journal.reserveV6Prepare(21, 1, B, -1);
    await journal.consensusState.write(ConsensusStateStore.heightFile(20), { highQC: null, lockedQC: null });
    await journal.consensusState.write(ConsensusStateStore.blockFile(20, A), { block: 1 });
    await journal.consensusState.write(ConsensusStateStore.timeoutFile(20, 0), { t: 1 });
    await journal.consensusState.write(ConsensusStateStore.heightFile(21), { highQC: null, lockedQC: null });
    assert.equal(await journal.compactThrough(20), 3);
    assert.equal(journal.v6Lock(20), null);
    journal.close();
    assert.deepEqual(await rows(directory), [
      { v: 2, height: 21, round: 0, step: "prepare", value: B },
      { v: 2, height: 21, round: 0, step: "lock", value: B, lockRound: 0 },
      { v: 2, height: 21, round: 0, step: "commit", value: B },
      { v: 2, height: 21, round: 0, step: "timeout", value: C },
      { v: 2, height: 21, round: 1, step: "prepare", value: B }
    ]);
    const store = new ConsensusStateStore(directory);
    assert.deepEqual(await store.list(), ["H-21.json"]);
    const reopened = await SigningJournal.open(directory);
    assert.deepEqual(reopened.v6Lock(21), { round: 0, blockHash: B });
    reopened.close();
  });
});

test("legacy-only journals: byte-identical rows and compaction, and no consensus-state directory is created", async () => {
  await withDir(async (directory) => {
    const journal = await SigningJournal.open(directory);
    await journal.reserveAttestation(1, 0, A);
    await journal.reserveSkip(2, 0, B);
    await journal.reserveAttestation(2, 1, C);
    const before = await readFile(join(directory, "signing-journal.ndjson"), "utf8");
    assert.equal(before,
      `{"height":1,"round":0,"kind":"attest","value":"${A}"}\n{"height":2,"round":0,"kind":"skip","value":"${B}"}\n{"height":2,"round":1,"kind":"attest","value":"${C}"}\n`);
    assert.equal(await journal.compactThrough(1), 1);
    assert.equal(await readFile(join(directory, "signing-journal.ndjson"), "utf8"),
      `{"height":2,"round":0,"kind":"skip","value":"${B}"}\n{"height":2,"round":1,"kind":"attest","value":"${C}"}\n`);
    assert.equal(await journal.compactThrough(1), 0);
    journal.close();
    await assert.rejects(() => access(join(directory, "consensus-state")), /ENOENT/);
  });
});

test("consensus-state store: atomic writes, missing or corrupt files read as absent, names are validated", async () => {
  await withDir(async (directory) => {
    const store = new ConsensusStateStore(directory);
    assert.equal(await store.read(ConsensusStateStore.heightFile(3)), undefined);
    await store.write(ConsensusStateStore.proposalFile(3, 2), { proposal: { round: 2 } });
    assert.deepEqual(await store.read(ConsensusStateStore.proposalFile(3, 2)), { proposal: { round: 2 } });
    await appendFile(join(directory, "consensus-state", ConsensusStateStore.proposalFile(3, 2)), "garbage");
    assert.equal(await store.read(ConsensusStateStore.proposalFile(3, 2)), undefined);
    await assert.rejects(() => store.write("../escape.json", {}), /Invalid consensus-state file name/);
    assert.throws(() => ConsensusStateStore.blockFile(3, "xyz"), /Invalid consensus-state hash/);
    // A crash before rename leaves the previous version intact.
    await store.write(ConsensusStateStore.heightFile(3), { v: 1 });
    await assert.rejects(() => store.write(ConsensusStateStore.heightFile(3), { v: 2 }, { afterTemporarySync: () => { throw new Error("crash"); } }), /crash/);
    assert.deepEqual(await store.read(ConsensusStateStore.heightFile(3)), { v: 1 });
    assert.deepEqual(await store.list(), ["H-3-r-2.proposal.json", "H-3.json"]);
    assert.equal(await store.pruneThrough(3), 2);
    assert.deepEqual(await store.list(), []);
  });
});
