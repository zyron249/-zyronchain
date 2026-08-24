import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  classifyPrivateFileSnapshot,
  samePrivateFileBytes,
} from "../src/local-security.js";

const base = {
  dev: 1,
  ino: 2,
  size: 6,
  mtimeMs: 100,
  ctimeMs: 200,
  nlink: 1,
};

test("hard-link metadata transition is classified separately from exact byte stability", () => {
  const linked = { ...base, ctimeMs: 201, nlink: 2 };
  assert.equal(classifyPrivateFileSnapshot(base, linked), "hardlink-metadata");
  assert.equal(samePrivateFileBytes(Buffer.from("secret"), Buffer.from("secret")), true);
});

test("same-length content mutation cannot satisfy hard-link metadata revalidation", () => {
  const linked = { ...base, ctimeMs: 201, nlink: 2 };
  assert.equal(classifyPrivateFileSnapshot(base, linked), "hardlink-metadata");
  assert.equal(samePrivateFileBytes(Buffer.from("secret"), Buffer.from("secreX")), false);
});

test("hard-link metadata acceptance is wired to a second descriptor-bound byte read", async () => {
  const source = await readFile(resolve(process.cwd(), "src/local-security.ts"), "utf8");
  assert.match(source, /disposition === "hardlink-metadata"[\s\S]*?revalidatePrivateFileBytesAfterHardlinkTransition/);
  assert.match(source, /handle\.read\(reread, total, reread\.length - total, total\)/);
  assert.match(source, /samePrivateFileBytes\(expectedBytes, reread\)/);
});
