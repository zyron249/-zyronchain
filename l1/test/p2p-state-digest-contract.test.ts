import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { canonicalJson, canonicalJsonDigest, sha256Hex } from "../src/codec.js";

test("State-v2 serving digest primitive preserves the canonical snapshot SHA-256 contract", () => {
  const representativeSnapshot = {
    height: 101,
    tip: {
      hash: "ab".repeat(32),
      header: { height: 101, stateRoot: "cd".repeat(32), timestampMs: 1_700_000_010_100 }
    },
    state: {
      ["02".repeat(33)]: 7,
      ["03".repeat(33)]: 11
    },
    validatorSchedule: [{ activationHeight: 1, validators: ["ef".repeat(20)] }],
    protocolSchedule: [{ activationHeight: 1, protocolVersion: 1 }]
  };

  const legacy = sha256Hex(canonicalJson(representativeSnapshot));
  const streamed = canonicalJsonDigest(representativeSnapshot);
  assert.equal(streamed.sha256, legacy);
  assert.equal(streamed.byteLength, Buffer.byteLength(canonicalJson(representativeSnapshot), "utf8"));
});

test("State-v2 serving selection does not rematerialize canonical JSON solely for hashing", async () => {
  const source = await readFile(new URL("../src/p2p-state.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function selectPortableState(");
  const end = source.indexOf("\nasync function responseForRequest(", start);
  assert.ok(start >= 0 && end > start, "selectPortableState source boundary must remain discoverable");
  const selection = source.slice(start, end);

  assert.match(selection, /canonicalJsonDigest\(snapshot\)\.sha256/);
  assert.doesNotMatch(selection, /sha256Hex\(canonicalJson\(snapshot\)\)/);
});
