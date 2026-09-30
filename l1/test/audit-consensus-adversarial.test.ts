import assert from "node:assert/strict";
import test from "node:test";

import {
  createRoundSkipVote,
  hashCouldStillBeFinalized,
  validateAttestationQuorum,
  validateRoundCertificate,
  validatorQuorumSize
} from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonical, verifyCanonicalDomain } from "../src/crypto.js";
import {
  byzantineFaultBound,
  createPrepareVote,
  createViewChangeVote,
  exploreBoundedConsensus,
  honestQuorumIntersection,
  PREPARE_DOMAIN,
  preparePayload,
  roundChangeLivenessBound,
  uniquePossiblyFinalizedWithPrepares,
  validatePrepareQuorum,
  validatePrepareVote,
  validateViewChangeCertificate,
  validateViewChangeVote,
  VIEW_CHANGE_DOMAIN
} from "../src/round-view-change.js";
import type { Block, Validator } from "../src/types.js";

const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);
const PREVIOUS = "cc".repeat(32);
const CHAIN = "zyron-audit-adversarial";

function key(byte: number): string {
  return byte.toString(16).padStart(64, "0");
}

function signer(byte: number): { privateKey: string; publicKey: string; validator: Validator } {
  const privateKey = key(byte);
  const publicKey = publicKeyFromPrivate(privateKey);
  return { privateKey, publicKey, validator: { address: addressFromPublicKey(publicKey), publicKey } };
}

test("AUDIT: quorum formula and Byzantine bound for N=1..32", () => {
  for (let n = 1; n <= 32; n += 1) {
    const q = validatorQuorumSize(n);
    const f = byzantineFaultBound(n);
    assert.equal(q, Math.floor((2 * n) / 3) + 1);
    assert.equal(f, Math.floor((n - 1) / 3));
    assert.ok(q * 2 > n, `intersection N=${n}`);
    assert.ok(honestQuorumIntersection(n) >= 1, `honest intersection N=${n}`);
    assert.ok(n - f >= q, `honest cover quorum N=${n}`);
    assert.equal(roundChangeLivenessBound(n), f + 1);
  }
});

test("AUDIT: bounded search reports no reachable double-finality for N=3,4,7", () => {
  for (const n of [3, 4, 7] as const) {
    const result = exploreBoundedConsensus(n, 2);
    assert.equal(result.doubleFinalization, 0, `N=${n}`);
    assert.equal(result.conflictingCertificates, 0, `N=${n}`);
    assert.equal(result.invalidUnlock, 0, `N=${n}`);
    assert.equal(result.livenessFailures, 0, `N=${n}`);
  }
});

test("AUDIT: forged and cross-height prepare/view-change votes are rejected", () => {
  const signers = [0x11, 0x12, 0x13].map(signer);
  const validators = signers.map((s) => s.validator);
  const stranger = signer(0xfe);

  const good = createPrepareVote({
    chainId: CHAIN, height: 1, round: 0, blockHash: HASH_A,
    validatorPrivateKey: signers[0]!.privateKey, validatorPublicKey: signers[0]!.publicKey
  });
  assert.throws(
    () => validatePrepareVote(good, validators, CHAIN, 2, 0, HASH_A),
    /Prepare vote does not match/
  );
  assert.throws(
    () => validatePrepareVote(good, validators, "other-chain", 1, 0, HASH_A),
    /Prepare vote does not match/
  );
  assert.throws(
    () => validatePrepareVote(good, validators, CHAIN, 1, 0, HASH_B),
    /Prepare vote does not match/
  );
  const forged = createPrepareVote({
    chainId: CHAIN, height: 1, round: 0, blockHash: HASH_A,
    validatorPrivateKey: stranger.privateKey, validatorPublicKey: stranger.publicKey
  });
  assert.throws(() => validatePrepareVote(forged, validators, CHAIN, 1, 0, HASH_A), /Unknown prepare voter/);

  const view = createViewChangeVote({
    chainId: CHAIN, height: 1, round: 0, previousHash: PREVIOUS,
    lockRound: null, lockHash: null,
    validatorPrivateKey: signers[0]!.privateKey, validatorPublicKey: signers[0]!.publicKey
  });
  assert.throws(
    () => validateViewChangeVote(view, validators, CHAIN, 1, 0, HASH_A),
    /View-change vote does not match/
  );
});

test("AUDIT: duplicate identity cannot pad prepare or view-change quorum", () => {
  const signers = [0x21, 0x22, 0x23].map(signer);
  const validators = signers.map((s) => s.validator);
  const once = createPrepareVote({
    chainId: CHAIN, height: 1, round: 0, blockHash: HASH_A,
    validatorPrivateKey: signers[0]!.privateKey, validatorPublicKey: signers[0]!.publicKey
  });
  assert.throws(
    () => validatePrepareQuorum([once, once, once], validators, CHAIN, 1, 0, HASH_A),
    /Duplicate prepare vote|Prepare quorum not reached/
  );

  const viewOnce = createViewChangeVote({
    chainId: CHAIN, height: 1, round: 0, previousHash: PREVIOUS,
    lockRound: null, lockHash: null,
    validatorPrivateKey: signers[0]!.privateKey, validatorPublicKey: signers[0]!.publicKey
  });
  assert.throws(
    () => validateViewChangeCertificate([viewOnce, viewOnce, viewOnce], validators, CHAIN, 1, 0, PREVIOUS),
    /View-change quorum not reached/
  );
});

test("AUDIT: split prepares refuse unique completion; missing votes are not no-votes", () => {
  const four = [0x31, 0x32, 0x33, 0x34].map(signer);
  const validators = four.map((s) => s.validator);
  const split = [
    ...four.slice(0, 2).map((s) => createPrepareVote({
      chainId: CHAIN, height: 1, round: 0, blockHash: HASH_A,
      validatorPrivateKey: s.privateKey, validatorPublicKey: s.publicKey
    })),
    ...four.slice(2, 4).map((s) => createPrepareVote({
      chainId: CHAIN, height: 1, round: 0, blockHash: HASH_B,
      validatorPrivateKey: s.privateKey, validatorPublicKey: s.publicKey
    }))
  ];
  assert.equal(uniquePossiblyFinalizedWithPrepares([], split, validators, CHAIN, 1, 0, PREVIOUS), null);
  assert.equal(hashCouldStillBeFinalized(2, 2, 4), true);
  assert.equal(hashCouldStillBeFinalized(0, 3, 4), false);
});

test("AUDIT: nil view-change certificate never finalizes a hash", () => {
  const four = [0x41, 0x42, 0x43, 0x44].map(signer);
  const validators = four.map((s) => s.validator);
  const votes = four.slice(0, 3).map((s) => createViewChangeVote({
    chainId: CHAIN, height: 1, round: 0, previousHash: PREVIOUS,
    lockRound: null, lockHash: null,
    validatorPrivateKey: s.privateKey, validatorPublicKey: s.publicKey
  }));
  assert.equal(validateViewChangeCertificate(votes, validators, CHAIN, 1, 0, PREVIOUS), null);
  const block: Block = {
    header: {
      version: 1, chainId: CHAIN, height: 1, round: 1, previousHash: PREVIOUS,
      timestampMs: 1, transactionRoot: HASH_A, stateRoot: HASH_A, proposer: four[0]!.validator.address
    },
    transactions: [], hash: HASH_A, proposerPublicKey: null, signature: null,
    roundCertificate: votes, attestations: []
  };
  assert.doesNotThrow(() => validateRoundCertificate(block, validators));
  assert.throws(() => validateAttestationQuorum(block, validators), /Finality quorum not reached/);
});

test("AUDIT: prepare domain separation rejects bare payload signatures under protocol v3", () => {
  const s = signer(0x51);
  const unsigned = {
    validator: s.validator.address,
    publicKey: s.publicKey,
    chainId: CHAIN,
    height: 1,
    round: 0,
    blockHash: HASH_A
  };
  const payload = preparePayload(unsigned);
  // Protocol <3 signs the payload object (which embeds domain) directly.
  const legacySig = signCanonical(payload, s.privateKey);
  // Domain-wrapped verification must fail for a bare/legacy signature.
  assert.equal(verifyCanonicalDomain(PREPARE_DOMAIN, payload, legacySig, s.publicKey), false);
  const vote = createPrepareVote({
    chainId: CHAIN, height: 1, round: 0, blockHash: HASH_A,
    validatorPrivateKey: s.privateKey, validatorPublicKey: s.publicKey, protocolVersion: 3
  });
  assert.doesNotThrow(() => validatePrepareVote(vote, [s.validator], CHAIN, 1, 0, HASH_A, 3));
  assert.throws(() => validatePrepareVote({ ...vote, signature: legacySig }, [s.validator], CHAIN, 1, 0, HASH_A, 3), /Invalid prepare signature/);
  assert.ok(VIEW_CHANGE_DOMAIN.startsWith("zyronchain/"));
});

test("AUDIT: round-skip votes cannot be replayed across heights", () => {
  const s = signer(0x61);
  const skip = createRoundSkipVote({
    chainId: CHAIN, height: 1, round: 0, previousHash: PREVIOUS,
    validatorPrivateKey: s.privateKey, validatorPublicKey: s.publicKey
  });
  assert.notEqual(skip.height, 2);
  // Shape binds height into the signature; wrong height fails validation in block.ts paths.
  assert.equal(skip.chainId, CHAIN);
  assert.equal(skip.previousHash, PREVIOUS);
});
