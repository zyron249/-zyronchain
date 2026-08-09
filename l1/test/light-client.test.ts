import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createBlockAttestation, createRoundSkipVote, createSignedBlock, validatorQuorumSize } from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate, signCanonical } from "../src/crypto.js";
import {
  activateNextValidatorSet,
  validateLightClientAnchor,
  verifyLightClientStateProof,
  verifyNextFinalizedHeader,
  type LightClientAnchor,
  type LightFinalityProof
} from "../src/light-client.js";
import { SparseMerkleState, validatorScheduleKey, type SparseMerkleProof } from "../src/state-v2.js";
import type { Block, Validator } from "../src/types.js";

const privateKeys = [1, 2, 3, 4].map((value) => value.toString(16).padStart(64, "0"));
const validators: Validator[] = privateKeys.map((key) => {
  const publicKey = publicKeyFromPrivate(key);
  return { address: addressFromPublicKey(publicKey), publicKey };
});

function fixture(protocolVersion = 2): { anchor: LightClientAnchor; block: Block; proof: LightFinalityProof; state: SparseMerkleState } {
  const state = SparseMerkleState.empty().set("account:alice", { balanceAtoms: 7, nonce: 1 });
  const anchor: LightClientAnchor = {
    version: 1,
    chainId: "zyron-light-test",
    genesisHash: "11".repeat(32),
    height: 100,
    blockHash: "22".repeat(32),
    stateRoot: "33".repeat(32),
    timestampMs: 1_700_000_000_000,
    protocolVersion,
    validators
  };
  let block = createSignedBlock({
    version: protocolVersion,
    chainId: anchor.chainId,
    height: 101,
    round: 0,
    previousHash: anchor.blockHash,
    timestampMs: anchor.timestampMs + 1_000,
    transactions: [],
    stateRoot: state.root(),
    proposerPrivateKey: privateKeys[0]!,
    proposerPublicKey: validators[0]!.publicKey
  });
  block = { ...block, attestations: privateKeys.slice(0, 3).map((key, index) =>
    createBlockAttestation(block, key, validators[index]!.publicKey)) };
  const proof: LightFinalityProof = {
    version: 1,
    header: block.header,
    hash: block.hash,
    proposerPublicKey: block.proposerPublicKey!,
    signature: block.signature!,
    roundCertificate: block.roundCertificate,
    attestations: block.attestations
  };
  return { anchor, block, proof, state };
}

test("light client enforces protocol-v3 signing domains while preserving v2 history", () => {
  const v2 = fixture(2);
  assert.equal(verifyNextFinalizedHeader(v2.anchor, v2.proof).blockHash, v2.block.hash);

  const v3 = fixture(3);
  assert.equal(verifyNextFinalizedHeader(v3.anchor, v3.proof).blockHash, v3.block.hash);
  assert.equal(verifyLightClientStateProof(
    verifyNextFinalizedHeader(v3.anchor, v3.proof),
    "account:alice",
    { balanceAtoms: 7, nonce: 1 },
    v3.state.prove("account:alice")
  ), true);

  const legacyProposal = {
    ...v3.proof,
    signature: signCanonical(v3.block.header, privateKeys[0]!)
  };
  assert.throws(
    () => verifyNextFinalizedHeader(v3.anchor, legacyProposal),
    /Invalid light-client proposer signature/
  );

  const legacyAttestation = {
    ...v3.proof,
    attestations: v3.proof.attestations.map((attestation, index) => ({
      ...attestation,
      signature: signCanonical({
        chainId: v3.block.header.chainId,
        height: v3.block.header.height,
        blockHash: v3.block.hash
      }, privateKeys[index]!)
    }))
  };
  assert.throws(
    () => verifyNextFinalizedHeader(v3.anchor, legacyAttestation),
    /Invalid validator attestation/
  );
});

test("light client extends an anchored validator set with independently verified finality", () => {
  const { anchor, block, proof } = fixture();
  const next = verifyNextFinalizedHeader(anchor, proof);
  assert.equal(next.height, 101);
  assert.equal(next.blockHash, block.hash);
  assert.equal(next.stateRoot, block.header.stateRoot);
  assert.deepEqual(next.validators, validators);
  assert.equal(next.genesisHash, anchor.genesisHash);
});

test("light-client finality fails closed on continuity, quorum, proposer and schema substitution", () => {
  const { anchor, proof } = fixture();
  assert.throws(() => verifyNextFinalizedHeader({ ...anchor, blockHash: "44".repeat(32) }, proof), /previous hash mismatch/);
  assert.throws(() => verifyNextFinalizedHeader(anchor, { ...proof, attestations: proof.attestations.slice(0, 2) }), /quorum/i);
  assert.throws(() => verifyNextFinalizedHeader(anchor, { ...proof, proposerPublicKey: validators[1]!.publicKey }), /proposer/);
  assert.throws(() => verifyNextFinalizedHeader(anchor, { ...proof, unexpected: true }), /Invalid light finality proof fields/);
  assert.throws(() => verifyNextFinalizedHeader(anchor, {
    ...proof,
    attestations: [proof.attestations[0]!, proof.attestations[0]!, proof.attestations[2]!]
  }), /Duplicate validator attestation/);
});

test("light-client trust anchors reject validator substitution and duplicates", () => {
  const { anchor } = fixture();
  assert.throws(() => validateLightClientAnchor({
    ...anchor,
    validators: [{ ...validators[0]!, address: validators[1]!.address }, ...validators.slice(1)]
  }), /Invalid or duplicate/);
  assert.throws(() => validateLightClientAnchor({
    ...anchor,
    validators: [validators[0]!, validators[0]!]
  }), /duplicate/i);
});

test("light client verifies State-v2 membership and non-membership only against the finalized root", () => {
  const { anchor, proof, state } = fixture();
  const finalized = verifyNextFinalizedHeader(anchor, proof);
  const membership = state.prove("account:alice");
  assert.equal(verifyLightClientStateProof(finalized, "account:alice", { balanceAtoms: 7, nonce: 1 }, membership), true);
  assert.equal(verifyLightClientStateProof(finalized, "account:alice", { balanceAtoms: 8, nonce: 1 }, membership), false);
  const missing = state.prove("account:bob");
  assert.equal(verifyLightClientStateProof(finalized, "account:bob", null, missing), true);
  assert.equal(verifyLightClientStateProof({ ...finalized, stateRoot: "55".repeat(32) }, "account:bob", null, missing), false);
});

test("light-client finality requires the certified predecessor round before accepting a view change", () => {
  const { anchor, state } = fixture();
  const roundCertificate = privateKeys.slice(0, 3).map((key, index) => createRoundSkipVote({
    chainId: anchor.chainId,
    height: 101,
    round: 0,
    previousHash: anchor.blockHash,
    validatorPrivateKey: key,
    validatorPublicKey: validators[index]!.publicKey
  }));
  let block = createSignedBlock({
    version: 2,
    chainId: anchor.chainId,
    height: 101,
    round: 1,
    previousHash: anchor.blockHash,
    timestampMs: anchor.timestampMs + 1_000,
    transactions: [],
    stateRoot: state.root(),
    proposerPrivateKey: privateKeys[1]!,
    proposerPublicKey: validators[1]!.publicKey,
    roundCertificate
  });
  block = { ...block, attestations: privateKeys.slice(0, 3).map((key, index) =>
    createBlockAttestation(block, key, validators[index]!.publicKey)) };
  const proof: LightFinalityProof = {
    version: 1,
    header: block.header,
    hash: block.hash,
    proposerPublicKey: block.proposerPublicKey!,
    signature: block.signature!,
    roundCertificate: block.roundCertificate,
    attestations: block.attestations
  };
  assert.equal(verifyNextFinalizedHeader(anchor, proof).blockHash, block.hash);
  assert.throws(() => verifyNextFinalizedHeader(anchor, {
    ...proof,
    roundCertificate: roundCertificate.slice(0, 2)
  }), /Round skip quorum not reached/);
});

test("light client rotates validators only through the current finalized State-v2 schedule proof", () => {
  const fifthPrivate = "05".padStart(64, "0");
  const fifthPublic = publicKeyFromPrivate(fifthPrivate);
  const nextValidators: Validator[] = [
    { address: addressFromPublicKey(fifthPublic), publicKey: fifthPublic },
    validators[1]!, validators[2]!, validators[3]!
  ];
  const activationHeight = 101;
  const state = SparseMerkleState.empty()
    .set("account:alice", { balanceAtoms: 7, nonce: 1 })
    .set(validatorScheduleKey(activationHeight), { validators: nextValidators });
  const anchor: LightClientAnchor = {
    version: 1,
    chainId: "zyron-light-test",
    genesisHash: "11".repeat(32),
    height: 100,
    blockHash: "22".repeat(32),
    stateRoot: state.root(),
    timestampMs: 1_700_000_000_000,
    protocolVersion: 2,
    validators
  };
  const scheduleProof = state.prove(validatorScheduleKey(activationHeight));
  const transitioned = activateNextValidatorSet(anchor, nextValidators, scheduleProof);
  assert.deepEqual(transitioned.validators, nextValidators);

  let block = createSignedBlock({
    version: 2,
    chainId: anchor.chainId,
    height: activationHeight,
    round: 0,
    previousHash: anchor.blockHash,
    timestampMs: anchor.timestampMs + 1_000,
    transactions: [],
    stateRoot: state.root(),
    proposerPrivateKey: fifthPrivate,
    proposerPublicKey: fifthPublic
  });
  block = { ...block, attestations: [fifthPrivate, privateKeys[1]!, privateKeys[2]!].map((key, index) =>
    createBlockAttestation(block, key, nextValidators[index]!.publicKey)) };
  const finality: LightFinalityProof = {
    version: 1, header: block.header, hash: block.hash,
    proposerPublicKey: block.proposerPublicKey!, signature: block.signature!,
    roundCertificate: [], attestations: block.attestations
  };
  assert.throws(() => verifyNextFinalizedHeader(anchor, finality), /Unexpected light-client proposer/);
  assert.equal(verifyNextFinalizedHeader(transitioned, finality).blockHash, block.hash);

  const substituted = [...nextValidators];
  substituted[0] = validators[0]!;
  assert.throws(() => activateNextValidatorSet(anchor, substituted, scheduleProof), /transition proof/);
  assert.throws(() => activateNextValidatorSet({ ...anchor, height: 99 }, nextValidators, scheduleProof), /transition proof/);
});

test("light-client portable vector reproduces finalized anchor and State-v2 proof", () => {
  const vector = JSON.parse(readFileSync(join(process.cwd(), "test-vectors/light-client-v1.json"), "utf8")) as {
    version: number;
    anchor: unknown;
    finalityProof: unknown;
    expectedNext: LightClientAnchor;
    stateProof: { key: string; value: unknown; proof: SparseMerkleProof };
  };
  assert.equal(vector.version, 1);
  const next = verifyNextFinalizedHeader(vector.anchor, vector.finalityProof);
  assert.deepEqual(next, vector.expectedNext);
  assert.equal(verifyLightClientStateProof(next, vector.stateProof.key, vector.stateProof.value, vector.stateProof.proof), true);
});

test("protocol-v3 public finality vector verifies identically and rejects its legacy signature twin", () => {
  const vector = JSON.parse(readFileSync(join(process.cwd(), "test-vectors/light-client-v3-finality.json"), "utf8")) as {
    version: number;
    anchor: LightClientAnchor;
    finalityProof: LightFinalityProof;
    expectedNext: LightClientAnchor;
    legacyProposerSignature: string;
  };
  assert.equal(vector.version, 1);
  assert.deepEqual(verifyNextFinalizedHeader(vector.anchor, vector.finalityProof), vector.expectedNext);
  assert.throws(
    () => verifyNextFinalizedHeader(vector.anchor, {
      ...vector.finalityProof,
      signature: vector.legacyProposerSignature
    }),
    /Invalid light-client proposer signature/
  );
});

test("property: light-client finality accepts exactly the >2/3 quorum boundary", () => {
  const allPrivate = Array.from({ length: 100 }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
  const allValidators = allPrivate.map((key) => {
    const publicKey = publicKeyFromPrivate(key);
    return { address: addressFromPublicKey(publicKey), publicKey } as Validator;
  });
  let seed = 0x5a17c0de;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const count = (seed % 100) + 1;
    const active = allValidators.slice(0, count);
    const anchor: LightClientAnchor = {
      version: 1, chainId: "zyron-light-property", genesisHash: "11".repeat(32), height: 0,
      blockHash: "22".repeat(32), stateRoot: "33".repeat(32), timestampMs: 1_700_000_000_000,
      protocolVersion: 2, validators: active
    };
    let block = createSignedBlock({
      version: 2, chainId: anchor.chainId, height: 1, round: 0, previousHash: anchor.blockHash,
      timestampMs: anchor.timestampMs + 1, transactions: [], stateRoot: "44".repeat(32),
      proposerPrivateKey: allPrivate[0]!, proposerPublicKey: active[0]!.publicKey
    });
    const quorum = validatorQuorumSize(count);
    const attestations = allPrivate.slice(0, quorum).map((key, index) =>
      createBlockAttestation(block, key, active[index]!.publicKey));
    block = { ...block, attestations };
    const proof: LightFinalityProof = {
      version: 1, header: block.header, hash: block.hash, proposerPublicKey: block.proposerPublicKey!,
      signature: block.signature!, roundCertificate: [], attestations
    };
    assert.equal(verifyNextFinalizedHeader(anchor, proof).blockHash, block.hash);
    assert.throws(() => verifyNextFinalizedHeader(anchor, { ...proof, attestations: attestations.slice(0, -1) }), /quorum/i);
  }
});
