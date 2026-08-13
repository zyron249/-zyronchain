import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BLOCK_TRANSACTIONS,
  MAX_VALIDATOR_COUNT,
  createBlockAttestation,
  createRoundSkipVote,
  validateAttestationQuorum,
  validateBlockShape,
  validateRoundSkipQuorum,
  validatorQuorumSize
} from "../src/block.js";
import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "../src/crypto.js";
import type { Block, Validator } from "../src/types.js";

const TEST_HASH = "11".repeat(32);

function minimalBlock(overrides: Partial<Block> = {}): Block {
  return {
    header: {
      version: 1,
      chainId: "zyron-certificate-bounds-test",
      height: 0,
      round: 0,
      previousHash: "00".repeat(32),
      timestampMs: 1,
      transactionRoot: TEST_HASH,
      stateRoot: TEST_HASH,
      proposer: "GENESIS"
    },
    transactions: [],
    hash: TEST_HASH,
    proposerPublicKey: null,
    signature: null,
    roundCertificate: [],
    attestations: [],
    ...overrides
  };
}

function testValidator(): { privateKey: string; publicKey: string; validator: Validator } {
  const privateKey = generatePrivateKey();
  const publicKey = publicKeyFromPrivate(privateKey);
  return {
    privateKey,
    publicKey,
    validator: { address: addressFromPublicKey(publicKey), publicKey }
  };
}

test("block shape rejects oversized transactions before per-entry validation", () => {
  const malformed = Array.from({ length: MAX_BLOCK_TRANSACTIONS + 1 }, () => null) as unknown as Block["transactions"];
  assert.throws(
    () => validateBlockShape(minimalBlock({ transactions: malformed })),
    /Too many transactions/
  );
});

test("block transaction count boundary proceeds to normal entry validation", () => {
  const malformed = Array.from({ length: MAX_BLOCK_TRANSACTIONS }, () => null) as unknown as Block["transactions"];
  assert.throws(
    () => validateBlockShape(minimalBlock({ transactions: malformed })),
    /transaction must be a plain object/
  );
});

test("block shape rejects oversized attestations before per-entry validation", () => {
  const malformed = Array.from({ length: MAX_VALIDATOR_COUNT + 1 }, () => null) as unknown as Block["attestations"];
  assert.throws(
    () => validateBlockShape(minimalBlock({ attestations: malformed })),
    /Too many block attestations/
  );
});

test("block shape rejects oversized round certificate before per-entry validation", () => {
  const malformed = Array.from({ length: MAX_VALIDATOR_COUNT + 1 }, () => null) as unknown as Block["roundCertificate"];
  assert.throws(
    () => validateBlockShape(minimalBlock({ roundCertificate: malformed })),
    /Too many round certificate entries/
  );
});

test("finality quorum rejects certificates larger than the active validator set before entry validation", () => {
  const signer = testValidator();
  const malformed = minimalBlock({ attestations: [null, null] as unknown as Block["attestations"] });
  assert.throws(
    () => validateAttestationQuorum(malformed, [signer.validator]),
    /Finality certificate exceeds active validator set/
  );
});

test("round skip quorum rejects certificates larger than the active validator set before entry validation", () => {
  const signer = testValidator();
  assert.throws(
    () => validateRoundSkipQuorum(
      [null, null] as unknown as Block["roundCertificate"],
      [signer.validator],
      "zyron-certificate-bounds-test",
      1,
      0,
      TEST_HASH
    ),
    /Round skip certificate exceeds active validator set/
  );
});

test("valid one-validator finality and round-skip certificates remain accepted", () => {
  const signer = testValidator();
  const base = minimalBlock();
  const block = minimalBlock({
    header: {
      ...base.header,
      height: 1,
      proposer: signer.validator.address
    },
    proposerPublicKey: signer.publicKey
  });
  block.attestations = [createBlockAttestation(block, signer.privateKey, signer.publicKey)];
  assert.doesNotThrow(() => validateAttestationQuorum(block, [signer.validator]));

  const vote = createRoundSkipVote({
    chainId: block.header.chainId,
    height: 1,
    round: 0,
    previousHash: block.header.previousHash,
    validatorPrivateKey: signer.privateKey,
    validatorPublicKey: signer.publicKey
  });
  assert.doesNotThrow(() => validateRoundSkipQuorum(
    [vote],
    [signer.validator],
    block.header.chainId,
    1,
    0,
    block.header.previousHash
  ));
});

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
