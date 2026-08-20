import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBoundedCheckpointJsonStructure,
  MAX_CHECKPOINT_JSON_NESTING_DEPTH,
  MAX_CHECKPOINT_JSON_STRUCTURAL_TOKENS
} from "../src/checkpoint-json-complexity.js";

const bytes = (value: string): Buffer => Buffer.from(value, "utf8");

test("checkpoint JSON nesting accepts exact bound and rejects bound plus one", () => {
  const exact = "[".repeat(MAX_CHECKPOINT_JSON_NESTING_DEPTH) + "0" + "]".repeat(MAX_CHECKPOINT_JSON_NESTING_DEPTH);
  assert.doesNotThrow(() => assertBoundedCheckpointJsonStructure(bytes(exact)));

  const overflow = "[".repeat(MAX_CHECKPOINT_JSON_NESTING_DEPTH + 1) + "0" + "]".repeat(MAX_CHECKPOINT_JSON_NESTING_DEPTH + 1);
  assert.throws(() => assertBoundedCheckpointJsonStructure(bytes(overflow)), /Checkpoint JSON complexity exceeded/);
});

test("checkpoint JSON structural-token bound is exact and fail-closed", () => {
  // A flat N-element array has N+1 structural tokens: opening/closing brackets
  // plus N-1 commas.
  const exactElements = MAX_CHECKPOINT_JSON_STRUCTURAL_TOKENS - 1;
  const exact = `[${Array(exactElements).fill("0").join(",")}]`;
  assert.doesNotThrow(() => assertBoundedCheckpointJsonStructure(bytes(exact)));

  const overflowElements = MAX_CHECKPOINT_JSON_STRUCTURAL_TOKENS;
  const overflow = `[${Array(overflowElements).fill("0").join(",")}]`;
  assert.throws(() => assertBoundedCheckpointJsonStructure(bytes(overflow)), /Checkpoint JSON complexity exceeded/);
});

test("checkpoint JSON scanner ignores punctuation and escaped quotes inside strings", () => {
  const value = JSON.stringify({
    payload: "{[,:]} \\\" still-string [,{}:]",
    nested: ["[,,,,::::{{{{", "\\\"}]}:,{"]
  });
  assert.doesNotThrow(() => assertBoundedCheckpointJsonStructure(bytes(value)));
});
