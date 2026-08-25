import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { samePrivateFileBytes } from "../src/local-security.js";

test("local-secret byte comparison preserves equality semantics", () => {
  assert.equal(samePrivateFileBytes(Buffer.from("secret-a"), Buffer.from("secret-a")), true);
  assert.equal(samePrivateFileBytes(Buffer.from("secret-a"), Buffer.from("secret-b")), false);
});

test("local-secret comparison digests remain zeroized in finally", () => {
  const source = readFileSync(resolve(process.cwd(), "src/local-security.ts"), "utf8");
  const helper = source.match(/export function samePrivateFileBytes[\s\S]*?\n}\n\nexport async function assertPrivateRegularFile/);
  assert.ok(helper, "samePrivateFileBytes helper must remain present");
  assert.match(helper[0], /try\s*{[\s\S]*timingSafeEqual\(expectedDigest, actualDigest\)[\s\S]*}\s*finally\s*{/);
  assert.match(helper[0], /expectedDigest\.fill\(0\)/);
  assert.match(helper[0], /actualDigest\.fill\(0\)/);
});
