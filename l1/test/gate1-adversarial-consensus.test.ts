import assert from "node:assert/strict";
import test from "node:test";

import {
  hashCouldStillBeFinalized,
  validateAttestationQuorum,
  validateRoundCertificate,
  validatorQuorumSize
} from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  byzantineFaultBound,
  createPrepareVote,
  createViewChangeVote,
  exploreBoundedConsensus,
  roundChangeLivenessBound,
  uniquePossiblyFinalizedWithPrepares,
  validatePrepareQuorum,
  validatePrepareVote,
  validateViewChangeCertificate,
  validateViewChangeVote
} from "../src/round-view-change.js";
import type { Block, Validator } from "../src/types.js";

const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);
const PREVIOUS = "cc".repeat(32);
const CHAIN_ID = "zyron-gate1-adversarial";

function privateKey(byte: number): string {
  return byte.toString(16).padStart(64, "0");
}

function validatorFrom(byte: number): { privateKey: string; publicKey: string; validator: Validator } {
  const key = privateKey(byte);
  const publicKey = publicKeyFromPrivate(key);
  return { privateKey: key, publicKey, validator: { address: addressFromPublicKey(publicKey), publicKey } };
}

function prepare(
  signer: { privateKey: string; publicKey: string },
  blockHash: string,
  round = 0
) {
  return createPrepareVote({
    chainId: CHAIN_ID,
    height: 1,
    round,
    blockHash,
    validatorPrivateKey: signer.privateKey,
    validatorPublicKey: signer.publicKey
  });
}

test("quorum and liveness bounds hold for N=3,4,7,10,25,50", () => {
  for (const n of [3, 4, 7, 10, 25, 50] as const) {
    const q = validatorQuorumSize(n);
    const f = byzantineFaultBound(n);
    assert.equal(q, Math.floor((2 * n) / 3) + 1);
    assert.ok(q * 2 > n, `quorum intersection for N=${n}`);
    assert.ok(n - f >= q, `honest validators cover quorum for N=${n}`);
    assert.equal(roundChangeLivenessBound(n), f + 1);
  }
});

test("bounded consensus search stays double-finalize free for N=3,4,7", () => {
  for (const n of [3, 4, 7] as const) {
    const explored = exploreBoundedConsensus(n, 2);
    assert.equal(explored.doubleFinalization, 0, `N=${n}`);
    assert.equal(explored.conflictingCertificates, 0, `N=${n}`);
    assert.equal(explored.livenessFailures, 0, `N=${n}`);
    assert.equal(explored.invalidUnlock, 0, `N=${n}`);
  }
});

test("unknown validators and wrong keys have weight 0 (rejected, never counted)", () => {
  const signers = [0x21, 0x22, 0x23].map((byte) => validatorFrom(byte));
  const validators = signers.map((signer) => signer.validator);
  const stranger = validatorFrom(0x99);
  const known = prepare(signers[0]!, HASH_A);
  assert.doesNotThrow(() => validatePrepareVote(known, validators, CHAIN_ID, 1, 0, HASH_A));

  const unknown = prepare(stranger, HASH_A);
  assert.throws(
    () => validatePrepareVote(unknown, validators, CHAIN_ID, 1, 0, HASH_A),
    /Unknown prepare voter/
  );

  const wrongKey = {
    ...known,
    publicKey: stranger.publicKey,
    signature: prepare(stranger, HASH_A).signature
  };
  assert.throws(
    () => validatePrepareVote(wrongKey, validators, CHAIN_ID, 1, 0, HASH_A),
    /Unknown prepare voter|Invalid prepare/
  );

  const unknownView = createViewChangeVote({
    chainId: CHAIN_ID,
    height: 1,
    round: 0,
    previousHash: PREVIOUS,
    lockRound: null,
    lockHash: null,
    validatorPrivateKey: stranger.privateKey,
    validatorPublicKey: stranger.publicKey
  });
  assert.throws(
    () => validateViewChangeVote(unknownView, validators, CHAIN_ID, 1, 0, PREVIOUS),
    /Unknown view-change voter/
  );
});

test("missing votes are neither yes nor no: unseen set can still hide a quorum", () => {
  // N=4, Q=3. Two visible prepares for HASH_A and two missing: HASH_A could still
  // reach quorum if the missing voters also prepare HASH_A, so completion must refuse.
  assert.equal(hashCouldStillBeFinalized(2, 2, 4), true);
  assert.equal(hashCouldStillBeFinalized(1, 1, 4), true);
  assert.equal(hashCouldStillBeFinalized(3, 3, 4), true);
  assert.equal(hashCouldStillBeFinalized(0, 0, 4), true);
  // Three seen opposing / skip-equivalent (visible 0 of 3) with N=4: one unseen cannot make Q=3.
  assert.equal(hashCouldStillBeFinalized(0, 3, 4), false);

  const signers = [0x31, 0x32, 0x33, 0x34].map((byte) => validatorFrom(byte));
  const validators = signers.map((signer) => signer.validator);
  const prepares = signers.slice(0, 2).map((signer) => prepare(signer, HASH_A));
  assert.equal(
    uniquePossiblyFinalizedWithPrepares([], prepares, validators, CHAIN_ID, 1, 0, PREVIOUS),
    null
  );
  assert.throws(
    () => validatePrepareQuorum(prepares, validators, CHAIN_ID, 1, 0, HASH_A),
    /Prepare quorum not reached: 2\/3/
  );
});

test("2+2 and 3+3+1 prepare quorums refuse unique completion (no plurality finalize)", () => {
  {
    const signers = [0x41, 0x42, 0x43, 0x44].map((byte) => validatorFrom(byte));
    const validators = signers.map((signer) => signer.validator);
    const prepares = [
      ...signers.slice(0, 2).map((signer) => prepare(signer, HASH_A)),
      ...signers.slice(2, 4).map((signer) => prepare(signer, HASH_B))
    ];
    assert.equal(
      uniquePossiblyFinalizedWithPrepares([], prepares, validators, CHAIN_ID, 1, 0, PREVIOUS),
      null
    );
  }
  {
    const signers = [0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57].map((byte) => validatorFrom(byte));
    const validators = signers.map((signer) => signer.validator);
    const prepares = [
      ...signers.slice(0, 3).map((signer) => prepare(signer, HASH_A)),
      ...signers.slice(3, 6).map((signer) => prepare(signer, HASH_B)),
      prepare(signers[6]!, HASH_A)
    ];
    // All 7 seen: A=4 < Q=5 and B=3 < Q=5 → refuse (no plurality finalize).
    assert.equal(
      uniquePossiblyFinalizedWithPrepares([], prepares, validators, CHAIN_ID, 1, 0, PREVIOUS),
      null
    );
  }
});

test("timeout/view-change path never finalizes a hash by itself", () => {
  const signers = [0x61, 0x62, 0x63, 0x64].map((byte) => validatorFrom(byte));
  const validators = signers.map((signer) => signer.validator);
  const votes = signers.slice(0, 3).map((signer) => createViewChangeVote({
    chainId: CHAIN_ID,
    height: 1,
    round: 0,
    previousHash: PREVIOUS,
    lockRound: null,
    lockHash: null,
    validatorPrivateKey: signer.privateKey,
    validatorPublicKey: signer.publicKey
  }));
  assert.equal(validateViewChangeCertificate(votes, validators, CHAIN_ID, 1, 0, PREVIOUS), null);
  const block: Block = {
    header: {
      version: 1,
      chainId: CHAIN_ID,
      height: 1,
      round: 1,
      previousHash: PREVIOUS,
      timestampMs: 1,
      transactionRoot: HASH_A,
      stateRoot: HASH_A,
      proposer: signers[0]!.validator.address
    },
    transactions: [],
    hash: HASH_A,
    proposerPublicKey: null,
    signature: null,
    roundCertificate: votes,
    attestations: []
  };
  assert.doesNotThrow(() => validateRoundCertificate(block, validators));
  assert.throws(() => validateAttestationQuorum(block, validators), /Finality quorum not reached: 0\/3/);
});

test("duplicate prepares from the same validator cannot pad a prepare quorum", () => {
  const signers = [0x71, 0x72, 0x73].map((byte) => validatorFrom(byte));
  const validators = signers.map((signer) => signer.validator);
  const once = prepare(signers[0]!, HASH_A);
  assert.throws(
    () => validatePrepareQuorum([once, once, once], validators, CHAIN_ID, 1, 0, HASH_A),
    /Duplicate prepare vote|Prepare quorum not reached/
  );
});
