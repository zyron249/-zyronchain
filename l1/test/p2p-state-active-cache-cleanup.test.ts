import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("current-tip recovery never removes a durable checkpoint that is active in another request", async () => {
  const source = await readFile(resolve(process.cwd(), "src/p2p-state.ts"), "utf8");
  const recovery = source.match(/if \(request\.tipHash === expected\.tipHash && !isMissingFile\(error\)\) \{([\s\S]*?)\n    \}/);
  assert.ok(recovery, "current-tip durable recovery block must remain explicit");
  const body = recovery[1];
  assert.ok(body !== undefined, "current-tip durable recovery body must be captured");
  const guard = body.indexOf("if (activePaths.has(durablePath)) throw error;");
  const removal = body.indexOf("await rm(durablePath, { recursive: true, force: true });");
  assert.ok(guard >= 0, "active durable checkpoint must fail closed rather than be removed");
  assert.ok(removal >= 0, "inactive invalid current-tip checkpoint should remain recoverable");
  assert.ok(guard < removal, "active-path guard must execute before destructive cleanup");
});
