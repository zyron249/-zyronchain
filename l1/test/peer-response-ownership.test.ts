import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../../src/node-base.ts", import.meta.url);

test("HTTP block sync retains decoded response ownership through accept/discard", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.equal(source.includes("const leasedBlocks = await getJsonRetained("), true);
  assert.equal(source.includes("for (const block of leasedBlocks.value)"), true);
  assert.equal(source.includes("leasedBlocks.release();"), true);
});

test("any-peer sync releases unselected candidates and selected candidate after handling", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.equal(source.includes("else result.value.release();"), true);
  assert.equal(source.includes("candidate.release();"), true);
});

test("ordinary peer JSON callers release retained decoded ownership before returning", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.equal(source.includes("const retained = await parseBoundedResponseRetained(response, maxBytes, validate);"), true);
  assert.equal(source.includes("retained.release();"), true);
});
