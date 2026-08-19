import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("State-v2 chunk parsing reuses the retained decoded graph without a full clone", async () => {
  const source = await readFile(join(process.cwd(), "src", "p2p-state.ts"), "utf8");
  const parseChunk = source.match(/function parseChunk\([\s\S]*?\n}\n\nfunction localIdentity/);
  assert.ok(parseChunk, "parseChunk source must remain present");
  assert.match(parseChunk[0], /items:\s*value\.items/);
  assert.doesNotMatch(parseChunk[0], /structuredClone\s*\(\s*value\.items\s*\)/);
});

test("State-v2 callers keep the retained frame until each chunk is persisted or consumed", async () => {
  const source = await readFile(join(process.cwd(), "src", "p2p-state.ts"), "utf8");
  const recordLoop = source.match(/for \(let start = resume\?\.nextRecordStart\(\)[\s\S]*?\n  }\n  const keys:/);
  const keyLoop = source.match(/for \(let start = resume\?\.nextKeyStart\(\)[\s\S]*?\n  }\n  if \(!resume/);
  for (const loop of [recordLoop, keyLoop]) {
    assert.ok(loop, "State-v2 chunk loop must remain present");
    assert.match(loop[0], /try \{[\s\S]*parseChunk[\s\S]*(?:putRecords|putKeys|\.push)\([\s\S]*finally \{\s*reply\.release\(\);\s*}/);
  }
});
