import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  validateHttpPeerAttestationShape,
  validateHttpPeerRoundSkipVoteShape
} from "../src/node.js";

const publicKey = publicKeyFromPrivate("11".repeat(32));
const validator = addressFromPublicKey(publicKey);
const signature = "ab".repeat(64);

function attestation() {
  return { validator, publicKey, signature };
}

function skipVote() {
  return {
    validator,
    publicKey,
    chainId: "zyron-test-chain",
    height: 12,
    round: 3,
    previousHash: "cd".repeat(32),
    signature
  };
}

test("HTTP peer attestation shape accepts only canonical fixed fields", () => {
  const value = attestation();
  assert.deepEqual(validateHttpPeerAttestationShape(value), value);
  assert.throws(
    () => validateHttpPeerAttestationShape({ ...value, nested: { retained: "x".repeat(1024) } }),
    /fields|attestation/i
  );
  assert.throws(
    () => validateHttpPeerAttestationShape({ ...value, publicKey: "00".repeat(63) }),
    /public key|hex/i
  );
  assert.throws(
    () => validateHttpPeerAttestationShape({ ...value, validator: `ZYN${"0".repeat(40)}` }),
    /validator/i
  );
});

test("HTTP peer round-skip shape rejects retained nested and malformed primitives", () => {
  const value = skipVote();
  assert.deepEqual(validateHttpPeerRoundSkipVoteShape(value), value);
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, extra: { retained: [1, 2, 3] } }),
    /fields|round skip/i
  );
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, chainId: "x".repeat(129) }),
    /round skip/i
  );
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, height: Number.MAX_SAFE_INTEGER + 1 }),
    /round skip/i
  );
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, previousHash: "ef".repeat(31) }),
    /previous hash|hex/i
  );
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, validator: `ZYN${"f".repeat(40)}` }),
    /validator/i
  );
});
