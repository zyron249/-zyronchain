import assert from "node:assert/strict";
import test from "node:test";

import { createBlockAttestation, createRoundSkipVote, createSignedBlock } from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  validateLightClientAnchor,
  verifyLightClientStateProof,
  verifyNextFinalizedHeader,
  type LightClientAnchor,
  type LightFinalityProof
} from "../src/light-client.js";
import { SparseMerkleState } from "../src/state-v2.js";
import type { Block, Validator } from "../src/types.js";

const privateKeys = [1, 2, 3, 4].map((value) => value.toString(16).padStart(64, "0"));
const validators: Validator[] = privateKeys.map((key) => {
  const publicKey = publicKeyFromPrivate(key);
  return { address: addressFromPublicKey(publicKey), publicKey };
});

function fixture(): { anchor: LightClientAnchor; block: Block; proof: LightFinalityProof; state: SparseMerkleState } {
  const state = SparseMerkleState.empty().set("account:alice", { balanceAtoms: 7, nonce: 1 });
  const anchor: LightClientAnchor = {
    version: 1,
    chainId: "zyron-light-test",
    genesisHash: "11".repeat(32),
    height: 100,
    blockHash: "22".repeat(32),
    stateRoot: "33".repeat(32),
    timestampMs: 1_700_000_000_000,
    protocolVersion: 2,
    validators
  };
  let block = createSignedBlock({
    version: 2,
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
