import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../src/codec.js";


test("canonical JSON uses locale-independent UTF-16 key ordering", () => {
  const value = {
    "é": 6,
    z: 4,
    "_": 2,
    "😀": 7,
    a: 3,
    "ä": 5,
    A: 1
  };
  const expected = '{"A":1,"_":2,"a":3,"z":4,"ä":5,"é":6,"😀":7}';
  assert.equal(canonicalJson(value), expected);
  assert.equal(sha256Hex(canonicalJson(value)), "80f499c6b47a4f2f9b86de581406de022202f437803c494b3a68762d913fd915");
});

test("canonical JSON is invariant to randomized object insertion order", () => {
  const entries: Array<[string, unknown]> = [
    ["z", 4], ["A", 1], ["😀", 7], ["_", 2], ["é", 6], ["a", 3], ["ä", 5]
  ];
  const expected = canonicalJson(Object.fromEntries(entries));
  let seed = 0x71c05e;
  const random = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const shuffled = [...entries];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = random() % (index + 1);
      [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
    }
    assert.equal(canonicalJson(Object.fromEntries(shuffled)), expected);
  }
});
