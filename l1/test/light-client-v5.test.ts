import assert from "node:assert/strict";
import test from "node:test";

import { createBlockAttestation, createSignedBlock } from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  activateNextProtocolVersion,
  activateNextValidatorSet,
  validateLightClientAnchor,
  verifyLightClientStateProof,
  verifyNextFinalizedHeader,
  type LightClientAnchor,
  type LightFinalityProof
} from "../src/light-client.js";
import { protocolScheduleKey, SparseMerkleState, validatorScheduleKey } from "../src/state-v2.js";
import type { Block, Validator } from "../src/types.js";

const privateKeys = [41, 42, 43, 44].map((value) => value.toString(16).padStart(64, "0"));
const validators: Validator[] = privateKeys.map((privateKey) => {
  const publicKey = publicKeyFromPrivate(privateKey);
  return { address: addressFromPublicKey(publicKey), publicKey };
});

function anchorFor(state: SparseMerkleState, protocolVersion: number): LightClientAnchor {
  return {
    version: 1,
    chainId: "zyron-light-v5-test",
    genesisHash: "11".repeat(32),
    height: 100,
    blockHash: "22".repeat(32),
    stateRoot: state.root(),
    timestampMs: 1_700_000_000_000,
    protocolVersion,
    validators
  };
}

function finalizedProof(anchor: LightClientAnchor, stateRoot: string, protocolVersion: number): { block: Block; proof: LightFinalityProof } {
  let block = createSignedBlock({
    version: protocolVersion,
    chainId: anchor.chainId,
    height: anchor.height + 1,
    round: 0,
    previousHash: anchor.blockHash,
    timestampMs: anchor.timestampMs + 1_000,
    transactions: [],
    stateRoot,
    proposerPrivateKey: privateKeys[0]!,
    proposerPublicKey: validators[0]!.publicKey
  });
  block = {
    ...block,
    attestations: privateKeys.slice(0, 3).map((privateKey, index) =>
      createBlockAttestation(block, privateKey, validators[index]!.publicKey))
  };
  return {
    block,
    proof: {
      version: 1,
      header: block.header,
      hash: block.hash,
      proposerPublicKey: block.proposerPublicKey!,
      signature: block.signature!,
      roundCertificate: block.roundCertificate,
      attestations: block.attestations
    }
  };
}

test("protocol-v5 anchors verify State-v2 proofs and reject unsupported protocol anchors", () => {
  const state = SparseMerkleState.empty().set("account:alice", { balanceAtoms: 7, nonce: 1 });
  const anchor = anchorFor(state, 5);
  assert.deepEqual(validateLightClientAnchor(anchor), anchor);
  assert.equal(
    verifyLightClientStateProof(anchor, "account:alice", { balanceAtoms: 7, nonce: 1 }, state.prove("account:alice")),
    true
  );
  assert.throws(() => validateLightClientAnchor({ ...anchor, protocolVersion: 4 }), /Invalid light-client anchor/);
});

test("protocol-v5 validator rotation remains authenticated by the current finalized State-v2 root", () => {
  const replacementPrivateKey = "45".padStart(64, "0");
  const replacementPublicKey = publicKeyFromPrivate(replacementPrivateKey);
  const nextValidators: Validator[] = [
    { address: addressFromPublicKey(replacementPublicKey), publicKey: replacementPublicKey },
    validators[1]!, validators[2]!, validators[3]!
  ];
  const activationHeight = 101;
  const state = SparseMerkleState.empty().set(
    validatorScheduleKey(activationHeight),
    { validators: nextValidators }
  );
  const anchor = anchorFor(state, 5);
  const transitioned = activateNextValidatorSet(
    anchor,
    nextValidators,
    state.prove(validatorScheduleKey(activationHeight))
  );
  assert.deepEqual(transitioned.validators, nextValidators);

  const substituted = [...nextValidators];
  substituted[0] = validators[0]!;
  assert.throws(
    () => activateNextValidatorSet(anchor, substituted, state.prove(validatorScheduleKey(activationHeight))),
    /transition proof/
  );
});

test("light client crosses a v3-to-v5 activation only with an authenticated protocol schedule proof", () => {
  const activationHeight = 101;
  const state = SparseMerkleState.empty()
    .set("account:alice", { balanceAtoms: 9, nonce: 2 })
    .set(protocolScheduleKey(activationHeight), { protocolVersion: 5 });
  const anchor = anchorFor(state, 3);
  const proof = state.prove(protocolScheduleKey(activationHeight));
  const transitioned = activateNextProtocolVersion(anchor, 5, proof);
  assert.equal(transitioned.protocolVersion, 5);

  const { block, proof: finalityProof } = finalizedProof(anchor, state.root(), 5);
  assert.throws(() => verifyNextFinalizedHeader(anchor, finalityProof), /protocol version mismatch/);
  assert.equal(verifyNextFinalizedHeader(transitioned, finalityProof).blockHash, block.hash);
  assert.equal(
    verifyLightClientStateProof(
      verifyNextFinalizedHeader(transitioned, finalityProof),
      "account:alice",
      { balanceAtoms: 9, nonce: 2 },
      state.prove("account:alice")
    ),
    true
  );

  assert.throws(
    () => activateNextProtocolVersion(anchor, 4, proof),
    /Unsupported light-client protocol transition/
  );
  assert.throws(
    () => activateNextProtocolVersion(anchor, 5, state.prove("account:alice")),
    /Invalid light-client protocol transition proof/
  );
});
