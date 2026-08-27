import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSigningJournalJsonComplexity,
  SIGNING_JOURNAL_MAX_JSON_NESTING_DEPTH,
  SIGNING_JOURNAL_MAX_JSON_STRUCTURAL_TOKENS
} from "../src/signing-journal-json-complexity.js";

test("signing journal JSON complexity accepts canonical records", () => {
  assert.doesNotThrow(() => assertSigningJournalJsonComplexity(JSON.stringify({
    height: 7,
    round: 3,
    kind: "attest",
    value: "a".repeat(64)
  })));
});

test("signing journal JSON complexity rejects excessive nesting", () => {
  const payload = `${"[".repeat(SIGNING_JOURNAL_MAX_JSON_NESTING_DEPTH + 1)}0${"]".repeat(SIGNING_JOURNAL_MAX_JSON_NESTING_DEPTH + 1)}`;
  assert.throws(
    () => assertSigningJournalJsonComplexity(payload),
    /Signing journal JSON complexity exceeded/
  );
});

test("signing journal JSON complexity rejects structural density", () => {
  const payload = `[${new Array(SIGNING_JOURNAL_MAX_JSON_STRUCTURAL_TOKENS + 2).fill("0").join(",")}]`;
  assert.throws(
    () => assertSigningJournalJsonComplexity(payload),
    /Signing journal JSON complexity exceeded/
  );
});

test("signing journal JSON complexity ignores punctuation inside strings", () => {
  const punctuation = "{[,:]}".repeat(SIGNING_JOURNAL_MAX_JSON_STRUCTURAL_TOKENS + 1);
  assert.doesNotThrow(() => assertSigningJournalJsonComplexity(JSON.stringify({ value: punctuation })));
});
