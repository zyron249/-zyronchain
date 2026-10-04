// F-01 phase 1: protocol v6 pure primitives (pacemaker, signed payloads,
// QC/TC/proposal/finality validation, SAFE-VOTE, signer intents).
import assert from "node:assert/strict";
import test from "node:test";

import { createRoundSkipVote, createSignedBlock, expectedValidator, validatorQuorumSize } from "../src/block.js";
import {
  V6_BLOCK_INTERVAL_MS,
  V6_COMMIT_VOTE_DOMAIN,
  V6_MAX_ROUND,
  V6_PREPARE_VOTE_DOMAIN,
  V6_PROPOSAL_DOMAIN,
  V6_ROUND_BASE_MS,
  V6_ROUND_MAX_MS,
  V6_TIMEOUT_DOMAIN,
  V6_TIMEOUT_GUARD_MS,
  ZERO_HASH,
  clockRound,
  proposalPayload,
  roundDuration,
  roundEnd,
  roundOffset,
  roundStart,
  safeVote,
  signV6,
  timeoutAllowedAt,
  timeoutPayload,
  validateCommitCertificate,
  validatePrepareQC,
  validatePrepareRequestCertificates,
  validateTimeoutCertificate,
  validateTimeoutResponse,
  validateTimeoutVoteShape,
  votePayload,
  type PrepareQC,
  type TimeoutCertificate,
  type V6Proposal,
  type V6TimeoutVote
} from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonicalDomain, verifyCanonicalDomain } from "../src/crypto.js";
import { BLOCK_INTERVAL_MS } from "../src/node.js";
import { LocalValidatorSigner, RemoteValidatorSigner, signWithValidator, validatorSigningDomain } from "../src/validator-signer.js";
import type { Block, Validator } from "../src/types.js";

const keys = ["71", "72", "73", "74"].map((byte) => byte.padStart(64, "0"));
const pubs = keys.map(publicKeyFromPrivate);
const validators: Validator[] = pubs.map((publicKey) => ({ address: addressFromPublicKey(publicKey), publicKey }));
const chainId = "zyron-v6-primitives";
const H = 7;
const TIP = 1_700_000_000_000;

function keyOf(validator: Validator): string { return keys[pubs.indexOf(validator.publicKey)]!; }

function block(round: number, salt = 0): Block {
  const proposer = expectedValidator(validators, H, round);
  return createSignedBlock({
    version: 6, chainId, height: H, round, previousHash: "ab".repeat(32), timestampMs: TIP + 30_000 + salt,
    transactions: [], stateRoot: "cd".repeat(32), proposerPrivateKey: keyOf(proposer), proposerPublicKey: proposer.publicKey
  });
}

function vote(domain: string, index: number, round: number, blockHash: string, height = H) {
  return { validator: validators[index]!.address, publicKey: pubs[index]!, signature: signV6(domain, votePayload(chainId, height, round, blockHash), keys[index]!) };
}

function qc(round: number, blockHash: string, signers = [0, 1, 2]): PrepareQC {
  return { chainId, height: H, round, blockHash, votes: signers.map((index) => vote(V6_PREPARE_VOTE_DOMAIN, index, round, blockHash)) };
}

function timeoutVote(index: number, round: number, highQCRound = -1, highQCHash = ZERO_HASH): V6TimeoutVote {
  const payload = { chainId, height: H, round, highQCRound, highQCHash };
  return { validator: validators[index]!.address, publicKey: pubs[index]!, ...payload, signature: signV6(V6_TIMEOUT_DOMAIN, timeoutPayload(payload), keys[index]!) };
}

function tc(round: number, votes: V6TimeoutVote[], highQC: PrepareQC | null): TimeoutCertificate {
  return { chainId, height: H, round, votes, highQC };
}

function proposal(round: number, blockHash: string, justifyRound: number, signerIndex?: number): V6Proposal {
  const payload = { chainId, height: H, round, blockHash, justifyRound };
  const leader = signerIndex ?? pubs.indexOf(expectedValidator(validators, H, round).publicKey);
  return { ...payload, signature: signV6(V6_PROPOSAL_DOMAIN, proposalPayload(payload), keys[leader]!) };
}

test("v6 pacemaker: linear growth capped at ROUND_MAX_MS, closed-form clockRound equals brute force", () => {
  assert.equal(V6_BLOCK_INTERVAL_MS, BLOCK_INTERVAL_MS);
  assert.equal(roundDuration(0), 30_000);
  assert.equal(roundDuration(1), 35_000);
  assert.equal(roundDuration(18), 120_000);
  assert.equal(roundDuration(19), 120_000);
  assert.equal(roundDuration(17), 115_000);
  let offset = 0;
  for (let round = 0; round <= 300; round += 1) {
    assert.equal(roundOffset(round), offset, `offset(${round})`);
    assert.equal(roundStart(TIP, round), TIP + BLOCK_INTERVAL_MS + offset);
    assert.equal(roundEnd(TIP, round), roundStart(TIP, round + 1));
    assert.equal(timeoutAllowedAt(TIP, round), roundEnd(TIP, round) - V6_TIMEOUT_GUARD_MS);
    // Boundaries.
    assert.equal(clockRound(TIP, roundStart(TIP, round)), round);
    assert.equal(clockRound(TIP, roundStart(TIP, round) - 1), round === 0 ? null : round - 1);
    assert.equal(clockRound(TIP, roundEnd(TIP, round) - 1), round);
    offset += roundDuration(round);
  }
  assert.equal(clockRound(TIP, TIP), null);
  assert.equal(clockRound(TIP, TIP + BLOCK_INTERVAL_MS - 1), null);
  // Random points against a brute-force scan.
  let seed = 12345;
  for (let sample = 0; sample < 2_000; sample += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const elapsed = seed % (roundOffset(250));
    let expected = 0;
    while (roundOffset(expected + 1) <= elapsed) expected += 1;
    assert.equal(clockRound(TIP, TIP + BLOCK_INTERVAL_MS + elapsed), expected);
  }
  assert.equal(clockRound(TIP, TIP + BLOCK_INTERVAL_MS + roundOffset(V6_MAX_ROUND)), V6_MAX_ROUND);
  assert.equal(clockRound(TIP, TIP + BLOCK_INTERVAL_MS + roundOffset(V6_MAX_ROUND) + V6_ROUND_MAX_MS), null);
  assert.throws(() => roundDuration(-1), /Invalid v6 round/);
  assert.ok(V6_ROUND_BASE_MS / 10 <= 3_000);
});

test("v6 signatures are domain separated: proposal, prepare, commit and timeout never verify as each other or as legacy messages", () => {
  const hash = block(0).hash;
  const payload = votePayload(chainId, H, 0, hash);
  const prepare = signV6(V6_PREPARE_VOTE_DOMAIN, payload, keys[0]!);
  assert.ok(verifyCanonicalDomain(V6_PREPARE_VOTE_DOMAIN, payload, prepare, pubs[0]!));
  for (const domain of [V6_COMMIT_VOTE_DOMAIN, V6_PROPOSAL_DOMAIN, V6_TIMEOUT_DOMAIN,
    "zyronchain/finality-attestation/v1", "zyronchain/round-skip/v1", "zyronchain/block-proposal/v1"]) {
    assert.equal(verifyCanonicalDomain(domain, payload, prepare, pubs[0]!), false, domain);
  }
  // The legacy finality attestation payload is {chainId, height, blockHash}; a v6 commit vote never verifies as one.
  const commit = signV6(V6_COMMIT_VOTE_DOMAIN, payload, keys[0]!);
  assert.equal(verifyCanonicalDomain("zyronchain/finality-attestation/v1", { chainId, height: H, blockHash: hash }, commit, pubs[0]!), false);
  assert.deepEqual(
    ["consensus-proposal", "prepare-vote", "commit-vote", "round-timeout"].map((intent) => validatorSigningDomain(intent as never)),
    [V6_PROPOSAL_DOMAIN, V6_PREPARE_VOTE_DOMAIN, V6_COMMIT_VOTE_DOMAIN, V6_TIMEOUT_DOMAIN]
  );
});

test("v6 PrepareQC validation: quorum of distinct members over one (H, r, hash) under the prepare domain only", () => {
  const hash = block(0).hash;
  assert.equal(validatorQuorumSize(4), 3);
  assert.doesNotThrow(() => validatePrepareQC(qc(0, hash), validators, chainId, H));
  assert.throws(() => validatePrepareQC(qc(0, hash, [0, 1]), validators, chainId, H), /quorum not reached: 2\/3/);
  const duplicated = qc(0, hash); duplicated.votes.push(duplicated.votes[0]!);
  assert.throws(() => validatePrepareQC(duplicated, validators, chainId, H), /Duplicate/);
  assert.throws(() => validatePrepareQC(qc(0, hash), validators, "zyron-other", H), /chain ID mismatch/);
  assert.throws(() => validatePrepareQC(qc(0, hash), validators, chainId, H + 1), /height mismatch/);
  const commitDomain = { ...qc(0, hash), votes: [0, 1, 2].map((index) => vote(V6_COMMIT_VOTE_DOMAIN, index, 0, hash)) };
  assert.throws(() => validatePrepareQC(commitDomain, validators, chainId, H), /Invalid Prepare QC signature/);
  const crossRound = qc(1, hash); crossRound.votes[2] = vote(V6_PREPARE_VOTE_DOMAIN, 2, 0, hash);
  assert.throws(() => validatePrepareQC(crossRound, validators, chainId, H), /Invalid Prepare QC signature/);
  const outsider = publicKeyFromPrivate("7f".padStart(64, "0"));
  const foreign = qc(0, hash);
  foreign.votes[0] = { validator: addressFromPublicKey(outsider), publicKey: outsider,
    signature: signV6(V6_PREPARE_VOTE_DOMAIN, votePayload(chainId, H, 0, hash), "7f".padStart(64, "0")) };
  assert.throws(() => validatePrepareQC(foreign, validators, chainId, H), /Unknown Prepare QC validator/);
  assert.throws(() => validatePrepareQC({ ...qc(0, hash), extra: 1 }, validators, chainId, H), /unexpected|keys|Invalid/i);
});

test("v6 TimeoutVote: highQCRound may equal the round (spec §5.1 Phase 0 correction) but not exceed it", () => {
  assert.doesNotThrow(() => validateTimeoutVoteShape(timeoutVote(0, 3, 3, "aa".repeat(32))));
  assert.doesNotThrow(() => validateTimeoutVoteShape(timeoutVote(0, 3, -1)));
  assert.throws(() => validateTimeoutVoteShape(timeoutVote(0, 3, 4, "aa".repeat(32))), /highQCRound/);
  assert.throws(() => validateTimeoutVoteShape(timeoutVote(0, 3, -1, "aa".repeat(32))), /highQC report/);
  assert.throws(() => validateTimeoutVoteShape(timeoutVote(0, 3, 1, ZERO_HASH)), /highQC report/);
  assert.throws(() => validateTimeoutVoteShape(timeoutVote(0, 3, -2)), /highQCRound/);
});

test("v6 timeout responses: the carried QC must verify and match the signed report exactly", () => {
  const B = block(0).hash;
  const lockQC = qc(0, B);
  assert.doesNotThrow(() => validateTimeoutResponse({ vote: timeoutVote(1, 0, 0, B), highQC: lockQC }, validators, chainId, H, 0));
  assert.doesNotThrow(() => validateTimeoutResponse({ vote: timeoutVote(1, 0), highQC: null }, validators, chainId, H, 0));
  assert.throws(() => validateTimeoutResponse({ vote: timeoutVote(1, 0, 0, B), highQC: null }, validators, chainId, H, 0), /missing/);
  assert.throws(() => validateTimeoutResponse({ vote: timeoutVote(1, 0), highQC: lockQC }, validators, chainId, H, 0), /unreported/);
  assert.throws(() => validateTimeoutResponse({ vote: timeoutVote(1, 0, 0, "ee".repeat(32)), highQC: lockQC }, validators, chainId, H, 0), /does not match/);
  assert.throws(() => validateTimeoutResponse({ vote: timeoutVote(1, 0, 0, B), highQC: qc(0, B, [0, 1]) }, validators, chainId, H, 0), /quorum/);
  assert.throws(() => validateTimeoutResponse({ vote: timeoutVote(1, 1), highQC: null }, validators, chainId, H, 0), /target mismatch/);
});

test("v6 TC validation: quorum, membership, and exactly the highest reported QC", () => {
  const B = block(0).hash;
  const none = tc(0, [0, 1, 2].map((index) => timeoutVote(index, 0)), null);
  assert.equal(validateTimeoutCertificate(none, validators, chainId, H, 0), -1);
  const withQC = tc(0, [timeoutVote(0, 0, 0, B), timeoutVote(1, 0), timeoutVote(2, 0)], qc(0, B));
  assert.equal(validateTimeoutCertificate(withQC, validators, chainId, H, 0), 0);
  assert.throws(() => validateTimeoutCertificate(tc(0, [timeoutVote(0, 0), timeoutVote(1, 0)], null), validators, chainId, H, 0), /quorum/);
  assert.throws(() => validateTimeoutCertificate({ ...withQC, highQC: null }, validators, chainId, H, 0), /missing the highest/);
  assert.throws(() => validateTimeoutCertificate({ ...none, highQC: qc(0, B) }, validators, chainId, H, 0), /unreported/);
  // Hiding a higher report behind a lower QC is rejected.
  const later = block(1).hash;
  const hidden = tc(1, [timeoutVote(0, 1, 1, later), timeoutVote(1, 1, 0, B), timeoutVote(2, 1)], qc(0, B));
  assert.throws(() => validateTimeoutCertificate(hidden, validators, chainId, H, 1), /not the highest/);
  // A forged report at the highest round with a different hash invalidates the TC.
  const conflicting = tc(0, [timeoutVote(0, 0, 0, B), timeoutVote(1, 0, 0, "ee".repeat(32)), timeoutVote(2, 0)], qc(0, B));
  assert.throws(() => validateTimeoutCertificate(conflicting, validators, chainId, H, 0), /does not match/);
  const dup = tc(0, [timeoutVote(0, 0), timeoutVote(0, 0), timeoutVote(1, 0)], null);
  assert.throws(() => validateTimeoutCertificate(dup, validators, chainId, H, 0), /Duplicate/);
  assert.throws(() => validateTimeoutCertificate(none, validators, chainId, H, 1), /target mismatch/);
});

test("v6 prepare request: leader signature, previous-round TC and the leader obligation", () => {
  const fresh0 = block(0);
  assert.equal(validatePrepareRequestCertificates({ proposal: proposal(0, fresh0.hash, -1), block: fresh0, tc: null }, validators, chainId, H), null);
  // Wrong signer.
  const wrongLeader = (pubs.indexOf(expectedValidator(validators, H, 0).publicKey) + 1) % 4;
  assert.throws(() => validatePrepareRequestCertificates({ proposal: proposal(0, fresh0.hash, -1, wrongLeader), block: fresh0, tc: null }, validators, chainId, H), /proposal signature/);
  // Round 0 cannot carry a TC; round > 0 must.
  const tc0 = tc(0, [0, 1, 2].map((index) => timeoutVote(index, 0)), null);
  assert.throws(() => validatePrepareRequestCertificates({ proposal: proposal(0, fresh0.hash, -1), block: fresh0, tc: tc0 }, validators, chainId, H), /must not carry a timeout/);
  const fresh1 = block(1);
  assert.throws(() => validatePrepareRequestCertificates({ proposal: proposal(1, fresh1.hash, -1), block: fresh1, tc: null }, validators, chainId, H), /missing the timeout/);
  assert.equal(validatePrepareRequestCertificates({ proposal: proposal(1, fresh1.hash, -1), block: fresh1, tc: tc0 }, validators, chainId, H), null);
  // Unjustified proposals must be fresh (header.round == r).
  assert.throws(() => validatePrepareRequestCertificates({ proposal: proposal(1, fresh0.hash, -1), block: fresh0, tc: tc0 }, validators, chainId, H), /fresh block/);
  // With a reported QC(0, B): the leader must re-propose B with justifyRound 0.
  const lockTC = tc(0, [timeoutVote(0, 0, 0, fresh0.hash), timeoutVote(1, 0), timeoutVote(2, 0)], qc(0, fresh0.hash));
  const justify = validatePrepareRequestCertificates({ proposal: proposal(1, fresh0.hash, 0), block: fresh0, tc: lockTC }, validators, chainId, H);
  assert.equal(justify?.round, 0);
  assert.throws(() => validatePrepareRequestCertificates({ proposal: proposal(1, fresh1.hash, -1), block: fresh1, tc: lockTC }, validators, chainId, H), /highest reported QC/);
  assert.throws(() => validatePrepareRequestCertificates({ proposal: proposal(1, fresh1.hash, 0), block: fresh1, tc: lockTC }, validators, chainId, H), /does not match its justification/);
  // Proposal/block binding and block from a later round.
  assert.throws(() => validatePrepareRequestCertificates({ proposal: proposal(0, fresh1.hash, -1), block: fresh0, tc: null }, validators, chainId, H), /block hash mismatch/);
  assert.throws(() => validatePrepareRequestCertificates({ proposal: proposal(0, fresh1.hash, -1), block: fresh1, tc: null }, validators, chainId, H), /later round/);
  // justifyRound must be < round (shape).
  assert.throws(() => validatePrepareRequestCertificates({ proposal: proposal(1, fresh0.hash, 1), block: fresh0, tc: lockTC }, validators, chainId, H), /justifyRound/);
});

test("v6 SAFE-VOTE: unlocked, same value, or strictly higher justification", () => {
  assert.equal(safeVote(null, "a".repeat(64), -1), true);
  const lock = { round: 2, blockHash: "a".repeat(64) };
  assert.equal(safeVote(lock, "a".repeat(64), -1), true);
  assert.equal(safeVote(lock, "b".repeat(64), -1), false);
  assert.equal(safeVote(lock, "b".repeat(64), 1), false);
  assert.equal(safeVote(lock, "b".repeat(64), 2), false, "non-strict unlock is forbidden");
  assert.equal(safeVote(lock, "b".repeat(64), 3), true);
});

test("v6 finality certificate: q commit votes over the commit round, no cross-round or prepare-domain votes", () => {
  const base = block(1);
  const commits = (round: number, signers = [0, 1, 2]) => signers.map((index) => vote(V6_COMMIT_VOTE_DOMAIN, index, round, base.hash));
  assert.doesNotThrow(() => validateCommitCertificate({ ...base, attestations: commits(1), commitRound: 1 }, validators));
  assert.doesNotThrow(() => validateCommitCertificate({ ...base, attestations: commits(3), commitRound: 3 }, validators));
  assert.throws(() => validateCommitCertificate({ ...base, attestations: commits(0), commitRound: 0 }, validators), /precedes/);
  assert.throws(() => validateCommitCertificate({ ...base, attestations: commits(1, [0, 1]), commitRound: 1 }, validators), /quorum/);
  assert.throws(() => validateCommitCertificate({ ...base, attestations: commits(1), commitRound: null }, validators), /requires a commit round/);
  assert.throws(() => validateCommitCertificate({ ...base, attestations: commits(1) }, validators), /requires a commit round/);
  const mixed = [...commits(1, [0, 1]), vote(V6_COMMIT_VOTE_DOMAIN, 2, 2, base.hash)];
  assert.throws(() => validateCommitCertificate({ ...base, attestations: mixed, commitRound: 1 }, validators), /Invalid Finality signature/);
  const prepares = [0, 1, 2].map((index) => vote(V6_PREPARE_VOTE_DOMAIN, index, 1, base.hash));
  assert.throws(() => validateCommitCertificate({ ...base, attestations: prepares, commitRound: 1 }, validators), /Invalid Finality signature/);
});

test("v6 signer intents: only under protocol 6; the remote signer refuses them unless explicitly enabled", async () => {
  const signer = new LocalValidatorSigner(keys[0]!);
  const payload = votePayload(chainId, H, 0, "a".repeat(64));
  const signature = await signWithValidator(signer, payload, "prepare-vote", 6);
  assert.ok(verifyCanonicalDomain(V6_PREPARE_VOTE_DOMAIN, payload, signature, pubs[0]!));
  assert.equal(signature, signCanonicalDomain(V6_PREPARE_VOTE_DOMAIN, payload, keys[0]!));
  for (const version of [1, 2, 3, 5]) {
    await assert.rejects(() => signWithValidator(signer, payload, "prepare-vote", version), /require protocol version 6/);
    await assert.rejects(() => signer.signCanonical(payload, "commit-vote", version), /require protocol version 6/);
  }
  // Legacy intents are unaffected.
  assert.equal(typeof await signWithValidator(signer, { a: 1 }, "round-skip", 5), "string");
  const remote = new RemoteValidatorSigner("http://127.0.0.1:9/sign", pubs[0]!, "t".repeat(40));
  for (const intent of ["consensus-proposal", "prepare-vote", "commit-vote", "round-timeout"] as const) {
    await assert.rejects(() => remote.signCanonical(payload, intent, 6), /not enabled for protocol v6/);
  }
});

test("createRoundSkipVote no longer defaults to protocol v1 (spec §15-6): an omitted version fails closed", () => {
  const input = { chainId, height: H, round: 0, previousHash: "ab".repeat(32), validatorPrivateKey: keys[0]!, validatorPublicKey: pubs[0]! };
  assert.throws(() => createRoundSkipVote(input as never), /explicit protocol version/);
  assert.throws(() => createRoundSkipVote({ ...input, protocolVersion: 0 }), /explicit protocol version/);
  // Explicit versions keep the exact legacy bytes: v1 and v2 are undomained and identical, v3+ domain-separated.
  const v1 = createRoundSkipVote({ ...input, protocolVersion: 1 });
  assert.equal(createRoundSkipVote({ ...input, protocolVersion: 2 }).signature, v1.signature);
  assert.notEqual(createRoundSkipVote({ ...input, protocolVersion: 3 }).signature, v1.signature);
});
