import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ZyronChain } from "../dist/src/chain.js";
import { canonicalJson, sha256Hex } from "../dist/src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import {
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer
} from "../dist/src/transaction.js";

const oldDist = process.env.ZYRON_OLD_L1_DIST;
assert.ok(oldDist, "ZYRON_OLD_L1_DIST must point at the built historical L1 dist directory");

const oldChainModule = await import(pathToFileURL(resolve(oldDist, "src/chain.js")).href);
const OldZyronChain = oldChainModule.ZyronChain;
assert.equal(typeof OldZyronChain, "function", "Historical binary does not export ZyronChain");

const validatorOnePrivate = "01".padStart(64, "0");
const validatorTwoPrivate = "02".padStart(64, "0");
const alicePrivate = "03".padStart(64, "0");
const oraclePrivate = "04".padStart(64, "0");
const bobPrivate = "05".padStart(64, "0");
const activityPoolPrivate = "06".padStart(64, "0");

const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const alicePublic = publicKeyFromPrivate(alicePrivate);
const oraclePublic = publicKeyFromPrivate(oraclePrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);
const alice = addressFromPublicKey(alicePublic);
const bob = addressFromPublicKey(publicKeyFromPrivate(bobPrivate));
const activityPool = addressFromPublicKey(publicKeyFromPrivate(activityPoolPrivate));

const genesis = {
  chainId: "zyron-mixed-version-rehearsal",
  timestampMs: 1_700_000_000_000,
  validators: [
    { address: validatorOne, publicKey: validatorOnePublic },
    { address: validatorTwo, publicKey: validatorTwoPublic }
  ],
  activityOracles: [oraclePublic],
  activityPool,
  allocations: [
    { address: alice, amountAtoms: 1_000_000_000 },
    { address: activityPool, amountAtoms: 5_000_000_000 }
  ]
};

function protocolChange(nonce, activationHeight, protocolVersion, timestampMs) {
  const proposal = {
    chainId: genesis.chainId,
    nonce,
    sender: validatorOne,
    activationHeight,
    protocolVersion
  };
  return createProtocolUpgrade({
    ...proposal,
    approvals: [
      createProtocolUpgradeApproval(proposal, validatorOnePrivate, validatorOnePublic),
      createProtocolUpgradeApproval(proposal, validatorTwoPrivate, validatorTwoPublic)
    ],
    timestampMs
  }, validatorOnePrivate, validatorOnePublic);
}

function proposerPrivateKey(height) {
  return height % 2 === 1 ? validatorOnePrivate : validatorTwoPrivate;
}

function finalizedBlock(chain, height, transactions = []) {
  const timestampMs = genesis.timestampMs + (height * 100);
  let block = chain.produceBlock(transactions, proposerPrivateKey(height), { timestampMs });
  block = chain.attestBlock(block, validatorOnePrivate);
  block = chain.attestBlock(block, validatorTwoPrivate);
  return { block, timestampMs };
}

function assertConverged(left, right, label) {
  assert.equal(right.height, left.height, `${label}: height diverged`);
  assert.equal(right.tip.hash, left.tip.hash, `${label}: tip hash diverged`);
  assert.equal(right.tip.header.stateRoot, left.tip.header.stateRoot, `${label}: state root diverged`);
  assert.equal(right.balance(alice), left.balance(alice), `${label}: Alice balance diverged`);
  assert.equal(right.balance(bob), left.balance(bob), `${label}: Bob balance diverged`);
  assert.equal(right.nonce(alice), left.nonce(alice), `${label}: Alice nonce diverged`);
}

const upgradeToV2 = protocolChange(1, 101, 2, genesis.timestampMs + 1);
const upgradeToV3 = protocolChange(2, 201, 3, genesis.timestampMs + 2);
const rollbackToV1 = protocolChange(3, 301, 1, genesis.timestampMs + 3);

const producer = new ZyronChain(genesis);
const historical = new OldZyronChain(genesis);

for (let height = 1; height <= 200; height += 1) {
  const transactions = [];
  if (height === 1) transactions.push(upgradeToV2, upgradeToV3, rollbackToV1);
  if (height === 102) {
    transactions.push(createTransfer({
      chainId: genesis.chainId,
      nonce: 1,
      sender: alice,
      receiver: bob,
      amountAtoms: 111,
      feeAtoms: 0,
      timestampMs: genesis.timestampMs + (height * 100) - 1
    }, alicePrivate, alicePublic));
  }
  const { block, timestampMs } = finalizedBlock(producer, height, transactions);
  producer.acceptBlock(block, timestampMs);
  historical.acceptBlock(structuredClone(block), timestampMs);
  assertConverged(producer, historical, `pre-v3 height ${height}`);
}

assert.equal(producer.protocolVersionAt(100), 1);
assert.equal(producer.protocolVersionAt(101), 2);
assert.equal(producer.protocolVersionAt(200), 2);
assert.equal(historical.protocolVersionAt(200), 2);

const historicalSnapshot = historical.snapshot();
const historicalSnapshotDigest = sha256Hex(canonicalJson(historicalSnapshot));

const activation = finalizedBlock(producer, 201);
producer.acceptBlock(activation.block, activation.timestampMs);
assert.equal(producer.protocolVersionAt(201), 3);
assert.equal(producer.tip.header.version, 3);

assert.throws(
  () => historical.acceptBlock(structuredClone(activation.block), activation.timestampMs),
  /Protocol version 3 is not supported by this binary/,
  "Historical pre-v3 binary must fail closed at the v3 activation boundary"
);
assert.equal(historical.height, 200, "Historical binary advanced past an unsupported protocol activation");

const upgraded = ZyronChain.fromTrustedSnapshot(genesis, historicalSnapshot, {
  tipHash: historicalSnapshot.tip.hash,
  snapshotSha256: historicalSnapshotDigest
});
assert.equal(upgraded.height, 200);
upgraded.acceptBlock(structuredClone(activation.block), activation.timestampMs);
assertConverged(producer, upgraded, "upgraded binary at v3 activation");

for (let height = 202; height <= 302; height += 1) {
  const transactions = [];
  if (height === 202) {
    transactions.push(createTransfer({
      chainId: genesis.chainId,
      nonce: 2,
      sender: alice,
      receiver: bob,
      amountAtoms: 222,
      feeAtoms: 0,
      timestampMs: genesis.timestampMs + (height * 100) - 1
    }, alicePrivate, alicePublic, 2));
  }
  if (height === 302) {
    transactions.push(createTransfer({
      chainId: genesis.chainId,
      nonce: 3,
      sender: alice,
      receiver: bob,
      amountAtoms: 333,
      feeAtoms: 0,
      timestampMs: genesis.timestampMs + (height * 100) - 1
    }, alicePrivate, alicePublic));
  }

  const { block, timestampMs } = finalizedBlock(producer, height, transactions);
  producer.acceptBlock(block, timestampMs);
  upgraded.acceptBlock(structuredClone(block), timestampMs);
  assertConverged(producer, upgraded, `post-upgrade height ${height}`);
}

assert.equal(producer.protocolVersionAt(300), 3);
assert.equal(producer.protocolVersionAt(301), 1);
assert.equal(producer.tip.header.version, 1);
assert.equal(producer.balance(bob), 666);
assert.equal(producer.nonce(alice), 3);

const postRollbackSnapshot = producer.snapshot();
const restarted = ZyronChain.fromTrustedSnapshot(genesis, postRollbackSnapshot, {
  tipHash: postRollbackSnapshot.tip.hash,
  snapshotSha256: sha256Hex(canonicalJson(postRollbackSnapshot))
});
assertConverged(producer, restarted, "post-rollback restart");
assert.equal(restarted.protocolVersionAt(302), 1);

console.log(JSON.stringify({
  status: "ok",
  historicalStopHeight: historical.height,
  v2ActivationHeight: 101,
  v3ActivationHeight: 201,
  rollbackHeight: 301,
  finalHeight: producer.height,
  finalProtocolVersion: producer.protocolVersionAt(producer.height),
  finalTipHash: producer.tip.hash,
  finalStateRoot: producer.tip.header.stateRoot
}, null, 2));
