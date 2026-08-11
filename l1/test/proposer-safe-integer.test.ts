import assert from "node:assert/strict";
import test from "node:test";

import { expectedValidator } from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import type { Validator } from "../src/types.js";

function validators(count: number): Validator[] {
  return Array.from({ length: count }, (_, index) => {
    const privateKey = (index + 1).toString(16).padStart(64, "0");
    const publicKey = publicKeyFromPrivate(privateKey);
    return { address: addressFromPublicKey(publicKey), publicKey };
  });
}

function exactIndex(height: number, round: number, count: number): number {
  return Number((BigInt(height - 1) + BigInt(round)) % BigInt(count));
}

test("expectedValidator stays exact when height plus round exceeds Number.MAX_SAFE_INTEGER", () => {
  const height = Number.MAX_SAFE_INTEGER;
  const round = Number.MAX_SAFE_INTEGER;
  for (const count of [2, 3, 7, 100]) {
    const set = validators(count);
    const expected = set[exactIndex(height, round, count)]!;
    assert.deepEqual(expectedValidator(set, height, round), expected);
  }
});

test("expectedValidator validates its direct height and round inputs", () => {
  const set = validators(2);
  for (const [height, round] of [
    [0, 0],
    [-1, 0],
    [1, -1],
    [Number.MAX_SAFE_INTEGER + 1, 0],
    [1, Number.MAX_SAFE_INTEGER + 1]
  ]) {
    assert.throws(() => expectedValidator(set, height, round), /Invalid proposer height or round/);
  }
  assert.throws(() => expectedValidator([], 1, 0), /Validator set is empty/);
});
