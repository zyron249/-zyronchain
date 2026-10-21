// Open TESTNET cold start (R37-1072-L1, review follow-up): when the restore
// replays protocol-v6 blocks, State-v2 data is written through better-sqlite3.
// A local storage failure there surfaces as a `SqliteError` (code
// `SQLITE_IOERR_*`, `SQLITE_FULL`, ...) with a string `code` but no `syscall`.
// It must count as a local I/O error like a Node system error, so the restore
// is retried from the same bundle and, if the disk keeps failing, start-up
// stops instead of creating a fresh TEST genesis. SQLite errors that are not
// about local storage (constraint, misuse, SQL errors) keep the existing
// non-retried path.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import Database from "better-sqlite3";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(l1Root, "scripts", "open-testnet.mjs");
const api: any = await import(pathToFileURL(script).href);
const { SqliteError } = Database;

const LOCAL_STORAGE_CODES = [
  "SQLITE_IOERR",
  "SQLITE_IOERR_WRITE",
  "SQLITE_IOERR_FSYNC",
  "SQLITE_IOERR_SHORT_READ",
  "SQLITE_FULL",
  "SQLITE_CANTOPEN",
  "SQLITE_NOMEM",
  "SQLITE_READONLY",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_PROTOCOL",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB"
];
const NOT_LOCAL_STORAGE_CODES = ["SQLITE_ERROR", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_MISMATCH", "SQLITE_MISUSE", "SQLITE_RANGE"];

function fakeRestore(outcomes: Array<Error | "ok">) {
  const calls: string[] = [];
  const waits: number[] = [];
  const moved: string[] = [];
  const restore = async (dir: string) => {
    calls.push(dir);
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
    if (outcome !== "ok") throw outcome;
    return { chainId: "zyron-test", height: 100 };
  };
  const options = {
    restore,
    moveAside: async (dir: string) => { moved.push(dir); return `${dir}.incomplete-${moved.length}`; },
    sleepImpl: async (ms: number) => { waits.push(ms); },
    log: () => {},
    onProgress: () => {}
  };
  return { calls, waits, moved, options };
}

test("R37-1072-L1: a real better-sqlite3 storage error (code, no syscall) counts as a local I/O error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-sqlite-io-"));
  try {
    const path = join(dir, "state-v2.sqlite");
    const writer = new Database(path);
    writer.exec("CREATE TABLE nodes (hash TEXT PRIMARY KEY NOT NULL)");
    writer.close();
    const reader = new Database(path, { readonly: true });
    let thrown: unknown;
    try { reader.prepare("INSERT INTO nodes (hash) VALUES (?)").run("00"); } catch (error) { thrown = error; } finally { reader.close(); }
    assert.ok(thrown instanceof SqliteError, "better-sqlite3 throws a SqliteError");
    const sqliteError = thrown as InstanceType<typeof SqliteError>;
    assert.match(sqliteError.code, /^SQLITE_READONLY/);
    assert.equal((sqliteError as any).syscall, undefined, "a SqliteError has no syscall");
    assert.equal(api.isLocalIoError(sqliteError), true);
    assert.equal(api.isLocalIoError(new Error("State v2 replay failed", { cause: sqliteError })), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R37-1072-L1: SQLite local storage error codes count as local I/O errors, also when wrapped as a cause", () => {
  for (const code of LOCAL_STORAGE_CODES) {
    const error = new SqliteError(`sqlite ${code}`, code);
    assert.equal(api.isLocalIoError(error), true, code);
    assert.equal(api.isLocalIoError(new Error("wrapped", { cause: new Error("inner", { cause: error }) })), true, `${code} (wrapped)`);
  }
});

test("R37-1072-L1: SQLite errors that are not about local storage stay non-local", () => {
  for (const code of NOT_LOCAL_STORAGE_CODES) {
    assert.equal(api.isLocalIoError(new SqliteError(`sqlite ${code}`, code)), false, code);
  }
  // Only better-sqlite3's own error type is classified by its SQLite code.
  assert.equal(api.isLocalIoError(Object.assign(new Error("not sqlite"), { code: "SQLITE_FULL" })), false);
});

test("R37-1072-L1: a transient SQLite I/O error during the restore is retried from the same bundle", async () => {
  const fake = fakeRestore([new Error("restore replay failed", { cause: new SqliteError("disk I/O error", "SQLITE_IOERR_WRITE") }), "ok"]);
  const result = await api.restoreNetworkWithLocalRetry("/net", { format: "bundle" }, "zyron-test", fake.options);
  assert.deepEqual(result, { chainId: "zyron-test", height: 100 });
  assert.deepEqual(fake.calls, ["/net", "/net"]);
  assert.deepEqual(fake.moved, ["/net"]);
  assert.deepEqual(fake.waits, [2_000]);
});

test("R37-1072-L1: a full disk under SQLite ends as a localIo error, never as a fresh-genesis error", async () => {
  const full = new SqliteError("database or disk is full", "SQLITE_FULL");
  const fake = fakeRestore([full]);
  await assert.rejects(api.restoreNetworkWithLocalRetry("/net", {}, "zyron-test", fake.options), (error: any) => {
    assert.equal(error.localIo, true);
    assert.match(error.message, /after 3 attempts: database or disk is full/);
    assert.equal(error.cause, full);
    return true;
  });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.waits, [2_000, 5_000]);
});

test("R37-1072-L1: a non-storage SQLite error is not retried and keeps the existing fallback", async () => {
  const constraint = new SqliteError("UNIQUE constraint failed: nodes.hash", "SQLITE_CONSTRAINT_PRIMARYKEY");
  const fake = fakeRestore([constraint, "ok"]);
  await assert.rejects(api.restoreNetworkWithLocalRetry("/net", {}, "zyron-test", fake.options), (thrown: any) => thrown === constraint && !thrown.localIo);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.moved, []);
});
