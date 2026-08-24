import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { samePrivateFileIdentity } from "../src/local-security.js";

test("local-secret identity binding rejects initial-vs-open device or inode drift", () => {
  assert.equal(samePrivateFileIdentity(10, 20, 10, 20), true);
  assert.equal(samePrivateFileIdentity(10, 20, 11, 20), false);
  assert.equal(samePrivateFileIdentity(10, 20, 10, 21), false);
});

test("local-secret open validation wires initial pathname identity into the descriptor gate", async () => {
  const source = await readFile(resolve(process.cwd(), "src/local-security.ts"), "utf8");
  assert.match(
    source,
    /requireSamePrivateRegularFile\([\s\S]*?"after opening",\s*initialPathMetadata\s*\)/,
    "the initial lstat identity must be carried across descriptor open"
  );
  assert.match(
    source,
    /initialPathMetadata[\s\S]*?samePrivateFileIdentity\(\s*initialPathMetadata\.dev,\s*initialPathMetadata\.ino,\s*descriptorMetadata\.dev,\s*descriptorMetadata\.ino\s*\)/,
    "the opened descriptor must be compared with the exact initial POSIX device/inode identity"
  );
});
