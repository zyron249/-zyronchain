import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, canonicalJsonDigest, sha256Hex } from "../src/codec.js";

function assertDigestMatches(value: unknown): void {
  const canonical = canonicalJson(value);
  const digest = canonicalJsonDigest(value);
  assert.equal(digest.byteLength, Buffer.byteLength(canonical, "utf8"));
  assert.equal(digest.sha256, sha256Hex(canonical));
}

test("canonical JSON digest matches canonical serialization for parsed JSON shapes", () => {
  const fixtures: unknown[] = [
    null,
    true,
    false,
    0,
    -0,
    42,
    -42,
    "plain",
    "quotes \" slash \\ controls \n \t",
    [3, 2, 1, null, true, "x"],
    { z: 1, a: 2, nested: { β: "beta", A: "alpha", a: "lower" } },
    { array: [{ b: 2, a: 1 }, [], [0, -0, 9007199254740991]] }
  ];
  for (const fixture of fixtures) assertDigestMatches(fixture);
});

test("canonical JSON digest preserves canonical UTF-16 key ordering", () => {
  const value = { "😀": 1, "\uffff": 2, A: 3, a: 4, "é": 5 };
  assertDigestMatches(value);
  assert.equal(canonicalJson(value), '{"A":3,"a":4,"é":5,"😀":1,"￿":2}');
});

test("canonical JSON digest streams long escaped strings without splitting surrogate pairs", () => {
  const long = `${"x".repeat((16 * 1024) - 1)}😀${"\\\"\n".repeat(9000)}`;
  assertDigestMatches({ long, tail: "done" });
});

test("canonical JSON digest preserves array null and object omission behavior", () => {
  assertDigestMatches([undefined, () => 1, Symbol("x"), "kept"]);
  assertDigestMatches({ omitted: undefined, alsoOmitted: () => 1, symbol: Symbol("x"), kept: 1 });
});

test("canonical JSON digest rejects unsafe numbers and cycles consistently", () => {
  for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 9007199254740992]) {
    assert.throws(() => canonicalJson(value), /Consensus numbers must be safe integers/);
    assert.throws(() => canonicalJsonDigest(value), /Consensus numbers must be safe integers/);
  }

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /Canonical JSON must not contain cycles/);
  assert.throws(() => canonicalJsonDigest(cyclic), /Canonical JSON must not contain cycles/);
});
