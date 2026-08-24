import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("hard-link byte reread is followed by current path identity revalidation", async () => {
  const source = await readFile(resolve(process.cwd(), "src/local-security.ts"), "utf8");
  assert.match(
    source,
    /revalidatePrivateFileBytesAfterHardlinkTransition\([\s\S]*?await requireSamePrivateRegularFile\([\s\S]*?"after hard-link byte revalidation"/
  );
});
