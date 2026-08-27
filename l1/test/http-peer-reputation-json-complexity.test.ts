import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertBoundedHttpReputationJsonStructure,
  MAX_HTTP_REPUTATION_JSON_NESTING_DEPTH,
  MAX_HTTP_REPUTATION_JSON_STRUCTURAL_TOKENS
} from "../src/http-peer-reputation-json-complexity.js";
import { PeerReputationStore } from "../src/peer-reputation.js";

test("HTTP peer reputation JSON complexity ignores punctuation inside quoted strings", () => {
  const quoted = JSON.stringify({ version: 1, peers: [{
    endpoint: `https://validator.example/${"{}[],:\\\"".repeat(200)}`,
    consecutiveFailures: 0,
    backoffUntilMs: 0,
    lastFailureMs: 0,
    lastSuccessMs: 0
  }] });
  assert.doesNotThrow(() => assertBoundedHttpReputationJsonStructure(quoted));
});

test("HTTP peer reputation JSON complexity rejects excessive nesting before parse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-http-reputation-depth-"));
  try {
    const nested = `${"[".repeat(MAX_HTTP_REPUTATION_JSON_NESTING_DEPTH + 1)}0${"]".repeat(MAX_HTTP_REPUTATION_JSON_NESTING_DEPTH + 1)}`;
    await writeFile(join(directory, "peer-reputation.json"), nested);
    await assert.rejects(() => PeerReputationStore.open(directory), /Corrupt peer reputation store/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP peer reputation JSON complexity rejects excessive structural density", () => {
  const dense = `[${Array.from({ length: MAX_HTTP_REPUTATION_JSON_STRUCTURAL_TOKENS + 8 }, () => "0").join(",")}]`;
  assert.throws(
    () => assertBoundedHttpReputationJsonStructure(dense),
    /HTTP peer reputation JSON complexity exceeded/
  );
});
