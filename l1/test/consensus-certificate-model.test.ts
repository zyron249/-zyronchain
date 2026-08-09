import assert from "node:assert/strict";
import test from "node:test";

import { validatorQuorumSize } from "../src/block.js";

test("model: finalized value prevents a conflicting value in every later certified round", () => {
  for (let validatorCount = 1; validatorCount <= 10; validatorCount += 1) {
    const quorum = validatorQuorumSize(validatorCount);
    const maxByzantine = Math.floor((validatorCount - 1) / 3);
    const certificates = masksAtLeast(validatorCount, quorum);
    const faultSets = masksAtMost(validatorCount, maxByzantine);

    for (const finalized of certificates) {
      for (const conflicting of certificates) {
        assertHasHonestIntersection(
          finalized,
          conflicting,
          faultSets,
          validatorCount,
          "conflicting finality certificates"
        );
      }

      // A proposal in any later round needs a skip certificate for the round
      // where this value finalized. An honest validator's journal cannot both
      // attest and skip that slot, so the two certificates cannot coexist.
      for (const skip of certificates) {
        assertHasHonestIntersection(
          finalized,
          skip,
          faultSets,
          validatorCount,
          "finality and progress certificates"
        );
      }
    }
  }
});

test("model: sequential skip certificates cannot bypass the first honest locked slot", () => {
  for (let validatorCount = 1; validatorCount <= 10; validatorCount += 1) {
    const quorum = validatorQuorumSize(validatorCount);
    const maxByzantine = Math.floor((validatorCount - 1) / 3);
    const certificates = masksAtLeast(validatorCount, quorum);
    const faultSets = masksAtMost(validatorCount, maxByzantine);

    for (let lockedAttestations = 0; lockedAttestations < (1 << validatorCount); lockedAttestations += 1) {
      if (popcount(lockedAttestations) < quorum) continue;
      for (const firstRequiredSkip of certificates) {
        assertHasHonestIntersection(
          lockedAttestations,
          firstRequiredSkip,
          faultSets,
          validatorCount,
          "locked round and required sequential skip"
        );
      }
    }
  }
});

test("model checker detects the known unsafe non-strict two-thirds mutation", () => {
  // For three validators, ceil(2N/3)=2 permits {A,B} and {B,C}. If B is the
  // single Byzantine validator, the intersection contains no honest signer.
  const validatorCount = 3;
  const unsafeQuorum = Math.ceil((2 * validatorCount) / 3);
  const certificates = masksAtLeast(validatorCount, unsafeQuorum);
  const faultSets = masksAtMost(validatorCount, 1);
  let counterexample: { left: number; right: number; faults: number } | undefined;

  outer:
  for (const left of certificates) {
    for (const right of certificates) {
      if (left === right) continue;
      for (const faults of faultSets) {
        if ((left & right & ~faults) === 0) {
          counterexample = { left, right, faults };
          break outer;
        }
      }
    }
  }

  assert.ok(counterexample, "mutation sensitivity failed: unsafe quorum produced no counterexample");
  assert.equal(validatorQuorumSize(validatorCount), 3);
});

function assertHasHonestIntersection(
  left: number,
  right: number,
  faultSets: number[],
  validatorCount: number,
  context: string
): void {
  for (const faults of faultSets) {
    const honestIntersection = left & right & ~faults;
    assert.notEqual(
      honestIntersection,
      0,
      `${context} can coexist for n=${validatorCount}: left=${bits(left, validatorCount)}, ` +
        `right=${bits(right, validatorCount)}, faults=${bits(faults, validatorCount)}`
    );
  }
}

function masksAtLeast(validatorCount: number, minimum: number): number[] {
  const masks: number[] = [];
  for (let mask = 0; mask < (1 << validatorCount); mask += 1) {
    if (popcount(mask) >= minimum) masks.push(mask);
  }
  return masks;
}

function masksAtMost(validatorCount: number, maximum: number): number[] {
  const masks: number[] = [];
  for (let mask = 0; mask < (1 << validatorCount); mask += 1) {
    if (popcount(mask) <= maximum) masks.push(mask);
  }
  return masks;
}

function popcount(value: number): number {
  let count = 0;
  for (let bits = value >>> 0; bits; bits >>>= 1) count += bits & 1;
  return count;
}

function bits(value: number, width: number): string {
  return value.toString(2).padStart(width, "0");
}
