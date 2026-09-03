import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { samePrivateFileIdentity } from "../src/local-security.js";

test("local-secret identity binding rejects initial-vs-open device or inode drift", () => {
  assert.equal(samePrivateFileIdentity(10n, 20n, 10n, 20n), true);
  assert.equal(samePrivateFileIdentity(10n, 20n, 11n, 20n), false);
  assert.equal(samePrivateFileIdentity(10n, 20n, 10n, 21n), false);
});

test("local-secret identity binding preserves adjacent values above Number safe precision", () => {
  const lower = 9_007_199_254_740_992n;
  const upper = lower + 1n;
  assert.equal(Number(lower), Number(upper), "control: Number must collapse the adjacent identities");
  assert.equal(samePrivateFileIdentity(1n, lower, 1n, upper), false);
  assert.equal(samePrivateFileIdentity(lower, 7n, upper, 7n), false);
});

test("local-secret open validation wires bigint pathname identity into a single descriptor gate", async () => {
  const source = await readFile(resolve(process.cwd(), "src/local-security.ts"), "utf8");
  assert.match(source, /lstat\(resolved, \{ bigint: true \}\)/, "initial pathname identity must use bigint lstat");
  assert.match(source, /const descriptorMetadata = await handle\.stat\(\{ bigint: true \}\)/, "opened descriptor validation must use one bigint stat snapshot");
  assert.doesNotMatch(source, /descriptorIdentity\s*=\s*await handle\.stat/, "identity validation must not add a second descriptor stat race window");
  assert.match(
    source,
    /requireSamePrivateRegularFile\([\s\S]*?"after opening",\s*initialPathMetadata\s*\)/,
    "the initial lstat identity must be carried across descriptor open"
  );
  const initialIdentityGate = source.indexOf("initialPathMetadata\n      && !samePrivateFileIdentity");
  const posixOnlyGate = source.indexOf('if (process.platform !== "win32")');
  assert.notEqual(initialIdentityGate, -1, "the opened descriptor must be compared with the exact initial device/inode identity");
  assert.notEqual(posixOnlyGate, -1, "POSIX-only ownership/permission gate must remain present");
  assert.ok(
    initialIdentityGate < posixOnlyGate,
    "initial pathname identity must be enforced before the POSIX-only ownership/permission branch so Windows cannot bypass it"
  );
  assert.match(
    source,
    /descriptorMetadata\.dev,\s*descriptorMetadata\.ino,\s*pathMetadata\.dev,\s*pathMetadata\.ino/,
    "current pathname identity must remain bound to the opened descriptor using exact values"
  );
});
