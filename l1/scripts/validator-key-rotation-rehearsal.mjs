import assert from "node:assert/strict";

import { expectedValidator } from "../dist/src/block.js";
import { canonicalJson, sha256Hex } from "../dist/src/codec.js";
import { ZyronChain } from "../dist/src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { createValidatorApproval, createValidatorSetUpdate } from "../dist/src/transaction.js";

const oldPrivateKeys = [1, 2, 3].map((value) => value.toString(16).padStart(64, "0"));
const oldPublicKeys = oldPrivateKeys.map(publicKeyFromPrivate);
const newPrivateKey = "04".padStart(64, "0");
const newPublicKey = publicKeyFromPrivate(newPrivateKey);
const oraclePublic = publicKeyFromPrivate("05".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("06".padStart(64, "0")));

const oldValidators = oldPublicKeys.map((publicKey) => ({
  publicKey,
  address: addressFromPublicKey(publicKey)
}));
const rotatedValidators = [oldValidators[0], oldValidators[1], {
  publicKey: newPublicKey,
  address: addressFromPublicKey(newPublicKey)
}];

const privateByPublic = new Map([
  ...oldPublicKeys.map((publicKey, index) => [publicKey, oldPrivateKeys[index]]),
  [newPublicKey, newPrivateKey]
]);

const genesis = {
  chainId: "zyron-validator-key-rotation-rehearsal",
  timestampMs: 1_700_000_000_000,
  validators: oldValidators,
  activityOracles: [oraclePublic],
  activityPool,
  allocations: [
    { address: oldValidators[0].address, amountAtoms: 1_000_000 },
    { address: activityPool, amountAtoms: 5_000_000 }
  ]
};

function privateKeyFor(publicKey) {
  const privateKey = privateByPublic.get(publicKey);
  assert.ok(privateKey, `Missing deterministic rehearsal private key for ${publicKey}`);
  return privateKey;
}

function finalizedBlock(chain, height, transactions = []) {
  const validators = chain.validatorsAt(height);
  const proposer = expectedValidator(validators, height, 0);
  const timestampMs = genesis.timestampMs + (height * 1_000);
  let block = chain.produceBlock(transactions, privateKeyFor(proposer.publicKey), { timestampMs });
  for (const validator of validators) {
    block = chain.attestBlock(block, privateKeyFor(validator.publicKey));
  }
  return { block, timestampMs };
}

const proposal = {
  chainId: genesis.chainId,
  nonce: 1,
  sender: oldValidators[0].address,
  activationHeight: 101,
  validators: rotatedValidators
};
const rotation = createValidatorSetUpdate({
  ...proposal,
  approvals: oldValidators.map((validator, index) =>
    createValidatorApproval(proposal, oldPrivateKeys[index], validator.publicKey)
  ),
  timestampMs: genesis.timestampMs + 1
}, oldPrivateKeys[0], oldValidators[0].publicKey);

let chain = new ZyronChain(genesis);
for (let height = 1; height <= 100; height += 1) {
  const { block, timestampMs } = finalizedBlock(chain, height, height === 1 ? [rotation] : []);
  chain.acceptBlock(block, timestampMs);
}

assert.deepEqual(chain.validatorsAt(100), oldValidators, "Old validator set changed before activation");
assert.deepEqual(chain.validatorsAt(101), rotatedValidators, "Rotated validator set did not activate at height 101");

const validatorsAt101 = chain.validatorsAt(101);
const proposer101 = expectedValidator(validatorsAt101, 101, 0);
const timestamp101 = genesis.timestampMs + 101_000;
let activationBlock = chain.produceBlock([], privateKeyFor(proposer101.publicKey), { timestampMs: timestamp101 });
assert.throws(
  () => chain.attestBlock(activationBlock, oldPrivateKeys[2]),
  /validator|active|configured|unknown/i,
  "Retired validator key was allowed to attest after rotation activation"
);
for (const validator of validatorsAt101) {
  activationBlock = chain.attestBlock(activationBlock, privateKeyFor(validator.publicKey));
}
chain.acceptBlock(activationBlock, timestamp101);

const validatorsAt102 = chain.validatorsAt(102);
const proposer102 = expectedValidator(validatorsAt102, 102, 0);
assert.equal(proposer102.publicKey, newPublicKey, "New validator key was not scheduled to propose immediately after rotation");
const { block: firstNewKeyProposal, timestampMs: timestamp102 } = finalizedBlock(chain, 102);
assert.equal(firstNewKeyProposal.proposerPublicKey, newPublicKey, "Rotated key did not produce the scheduled proposal");
chain.acceptBlock(firstNewKeyProposal, timestamp102);

for (let height = 103; height <= 110; height += 1) {
  const { block, timestampMs } = finalizedBlock(chain, height);
  chain.acceptBlock(block, timestampMs);
}

const preRestartSnapshot = chain.snapshot();
const snapshotDigest = sha256Hex(canonicalJson(preRestartSnapshot));
chain = ZyronChain.fromTrustedSnapshot(genesis, preRestartSnapshot, {
  tipHash: preRestartSnapshot.tip.hash,
  snapshotSha256: snapshotDigest
});
assert.deepEqual(chain.validatorsAt(111), rotatedValidators, "Restart lost the activated validator-key rotation");

for (let height = 111; height <= 120; height += 1) {
  const { block, timestampMs } = finalizedBlock(chain, height);
  chain.acceptBlock(block, timestampMs);
}

assert.equal(chain.height, 120);
assert.deepEqual(chain.validatorsAt(120), rotatedValidators);
assert.ok(!chain.validatorsAt(120).some((validator) => validator.publicKey === oldPublicKeys[2]));
assert.ok(chain.validatorsAt(120).some((validator) => validator.publicKey === newPublicKey));

console.log(JSON.stringify({
  status: "ok",
  rotationAuthorizedHeight: 1,
  activationHeight: 101,
  retiredValidatorPublicKey: oldPublicKeys[2],
  replacementValidatorPublicKey: newPublicKey,
  retiredKeyRejectedAtActivation: true,
  replacementKeyFirstProposalHeight: 102,
  restartVerifiedHeight: 110,
  finalHeight: chain.height,
  finalTipHash: chain.tip.hash,
  finalStateRoot: chain.tip.header.stateRoot,
  activeValidatorPublicKeys: chain.validatorsAt(chain.height).map((validator) => validator.publicKey)
}, null, 2));
