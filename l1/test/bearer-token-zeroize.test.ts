import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("bearer-token comparison preserves timing-safe equality and zeroizes both buffers in finally", async () => {
  const source = await readFile(resolve(process.cwd(), "src/node-base.ts"), "utf8");
  const helper = source.match(/function validBearerToken[\s\S]*?\n}\n\nclass PeerAuthenticationError/);
  assert.ok(helper, "expected bearer-token comparison helper");
  assert.match(helper[0], /if \(!header\?\.startsWith\("Bearer "\)\) return false;/);
  assert.match(helper[0], /return provided\.length === wanted\.length && timingSafeEqual\(provided, wanted\);/);
  assert.match(
    helper[0],
    /try \{[\s\S]*?timingSafeEqual\(provided, wanted\);[\s\S]*?\} finally \{\s*provided\.fill\(0\);\s*wanted\.fill\(0\);\s*\}/
  );
});
