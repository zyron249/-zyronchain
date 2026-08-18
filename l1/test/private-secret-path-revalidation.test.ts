import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("private secret reader revalidates canonical path after open and after read", async () => {
  const source = await readFile(resolve(process.cwd(), "src", "local-security.ts"), "utf8");
  assert.match(source, /const canonical = await realpath\(resolved\)/);
  assert.match(
    source,
    /requireSamePrivateRegularFile\(resolved, label, canonical, handle, "after opening"\)/
  );
  assert.match(
    source,
    /requireSamePrivateRegularFile\(opened\.resolved, label, opened\.canonical, opened\.handle, "during reading"\)/
  );
  assert.match(source, /const observedCanonical = await realpath\(resolved\)/);
  assert.match(source, /if \(observedCanonical !== expectedCanonical\)/);
});

test("private secret reader keeps POSIX no-follow and descriptor identity checks", async () => {
  const source = await readFile(resolve(process.cwd(), "src", "local-security.ts"), "utf8");
  assert.match(source, /constants\.O_RDONLY \| constants\.O_NOFOLLOW \| constants\.O_NONBLOCK/);
  assert.match(source, /descriptorMetadata\.dev !== pathMetadata\.dev/);
  assert.match(source, /descriptorMetadata\.ino !== pathMetadata\.ino/);
});
