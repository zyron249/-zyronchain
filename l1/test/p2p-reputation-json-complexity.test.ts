import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertBoundedNativeReputationJsonStructure,
  MAX_NATIVE_REPUTATION_JSON_NESTING_DEPTH,
  MAX_NATIVE_REPUTATION_JSON_STRUCTURAL_TOKENS
} from "../src/p2p-reputation-json-complexity.js";
import { NativePeerReputationStore } from "../src/p2p-reputation.js";

test("native reputation JSON complexity ignores punctuation inside quoted strings", () => {
  const quoted = JSON.stringify({ version: 1, peers: [], note: "[{,:}]\\\"[{,:}]" });
  assert.doesNotThrow(() => assertBoundedNativeReputationJsonStructure(quoted));
});

test("native reputation JSON complexity rejects excessive nesting", () => {
  const payload = `${"[".repeat(MAX_NATIVE_REPUTATION_JSON_NESTING_DEPTH + 1)}0${"]".repeat(MAX_NATIVE_REPUTATION_JSON_NESTING_DEPTH + 1)}`;
  assert.throws(
    () => assertBoundedNativeReputationJsonStructure(payload),
    /Native peer reputation JSON complexity exceeded/
  );
});

test("native reputation JSON complexity rejects excessive structural-token density", () => {
  const payload = `[${Array.from({ length: MAX_NATIVE_REPUTATION_JSON_STRUCTURAL_TOKENS }, () => "0").join(",")}]`;
  assert.throws(
    () => assertBoundedNativeReputationJsonStructure(payload),
    /Native peer reputation JSON complexity exceeded/
  );
});

test("native reputation store rejects structurally pathological snapshot before schema validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-native-reputation-complexity-"));
  try {
    const payload = `${"[".repeat(MAX_NATIVE_REPUTATION_JSON_NESTING_DEPTH + 1)}0${"]".repeat(MAX_NATIVE_REPUTATION_JSON_NESTING_DEPTH + 1)}`;
    await writeFile(join(directory, "native-peer-reputation.json"), payload);
    await assert.rejects(
      () => NativePeerReputationStore.open(directory),
      /Corrupt native peer reputation store/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
