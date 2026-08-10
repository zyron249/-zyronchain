import assert from "node:assert/strict";

import { createRoundSkipVote } from "../dist/src/block.js";
import { canonicalJson, sha256Hex } from "../dist/src/codec.js";
import { ZyronChain } from "../dist/src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import {
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer
} from "../dist/src/transaction.js";

const TOTAL_HEIGHTS = 600;
const PARTITION_PERIOD = 50;
const PARTITION_LENGTH = 7;

const validatorPrivateKeys = [1, 2, 3, 4].map((value) => value.toString(16).padStart(64, "0"));
const validatorPublicKeys = validatorPrivateKeys.map(publicKeyFromPrivate);
const validators = validatorPublicKeys.map((publicKey) => ({
  publicKey,
  address: addressFromPublicKey(publicKey)
}));
const alicePrivate = "05".padStart(64, "0");
const alicePublic = publicKeyFromPrivate(alicePrivate);
const alice = addressFromPublicKey(alicePublic);
const bob = addressFromPublicKey(publicKeyFromPrivate("07".padStart(64, "0")));
const oraclePublic = publicKeyFromPrivate("06".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("08".padStart(64, "0")));

const genesis = {
  chainId: "zyron-composite-adversarial-soak",
  timestampMs: 1_700_000_000_000,
  validators,
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
    sender: validators[0].address,
    activationHeight,
    protocolVersion
  };
  return createProtocolUpgrade({
    ...proposal,
    approvals: [0, 1, 2].map((index) =>
      createProtocolUpgradeApproval(proposal, validatorPrivateKeys[index], validatorPublicKeys[index])
    ),
    timestampMs
  }, validatorPrivateKeys[0], validatorPublicKeys[0]);
}

function partitionedReplica(height) {
  const phase = (height - 1) % PARTITION_PERIOD;
  return phase < PARTITION_LENGTH ? Math.floor((height - 1) / PARTITION_PERIOD) % 4 : -1;
}

function proposerPrivateKey(height, round) {
  return validatorPrivateKeys[(height - 1 + round) % validatorPrivateKeys.length];
}

function roundCertificate(chain, height, round) {
  if (round === 0) return [];
  assert.equal(round, 1, "Soak currently exercises one certified sequential view change at a time");
  const protocolVersion = chain.protocolVersionAt(height);
  return [0, 1, 2].map((index) => createRoundSkipVote({
    chainId: genesis.chainId,
    height,
    round: 0,
    previousHash: chain.tip.hash,
    validatorPrivateKey: validatorPrivateKeys[index],
    validatorPublicKey: validatorPublicKeys[index],
    protocolVersion
  }));
}

function finalizedBlock(chain, height, transactions, round, timestampMs) {
  const certificate = roundCertificate(chain, height, round);
  let block = chain.produceBlock(transactions, proposerPrivateKey(height, round), {
    round,
    roundCertificate: certificate,
    timestampMs
  });
  for (const index of [0, 1, 2]) block = chain.attestBlock(block, validatorPrivateKeys[index]);
  return block;
}

function transfer(nonce, height, protocolVersion) {
  return createTransfer({
    chainId: genesis.chainId,
    nonce,
    sender: alice,
    receiver: bob,
    amountAtoms: 10,
    feeAtoms: 0,
    timestampMs: genesis.timestampMs + (height * 1_000) - 1
  }, alicePrivate, alicePublic, protocolVersion >= 3 ? 2 : 1);
}

function assertConverged(reference, replica, label) {
  assert.equal(replica.height, reference.height, `${label}: height diverged`);
  assert.equal(replica.tip.hash, reference.tip.hash, `${label}: tip diverged`);
  assert.equal(replica.tip.header.stateRoot, reference.tip.header.stateRoot, `${label}: state root diverged`);
  assert.equal(replica.protocolVersionAt(replica.height), reference.protocolVersionAt(reference.height), `${label}: protocol diverged`);
  assert.equal(replica.balance(alice), reference.balance(alice), `${label}: Alice balance diverged`);
  assert.equal(replica.balance(bob), reference.balance(bob), `${label}: Bob balance diverged`);
  assert.equal(replica.nonce(alice), reference.nonce(alice), `${label}: Alice nonce diverged`);
}

const canonical = new ZyronChain(genesis);
const replicas = Array.from({ length: 4 }, () => new ZyronChain(genesis));
const history = [];
let transferNonce = 0;
let viewChanges = 0;
let insufficientFinalityRejections = 0;
let duplicateAttestationRejections = 0;
let replayRejections = 0;
let futureClockRejections = 0;
let restartRecoveries = 0;
let partitionedDeliveries = 0;

const upgradeToV2 = protocolChange(1, 101, 2, genesis.timestampMs + 1);
const upgradeToV3 = protocolChange(2, 201, 3, genesis.timestampMs + 2);

function catchUpReplica(index) {
  const replica = replicas[index];
  for (let height = replica.height + 1; height <= canonical.height; height += 1) {
    const block = history[height - 1];
    assert.ok(block, `Missing finalized history at height ${height}`);
    replica.acceptBlock(structuredClone(block), block.header.timestampMs);
  }
}

for (let height = 1; height <= TOTAL_HEIGHTS; height += 1) {
  const partitioned = partitionedReplica(height);
  for (let index = 0; index < replicas.length; index += 1) {
    if (index !== partitioned && replicas[index].height < canonical.height) catchUpReplica(index);
  }

  const transactions = [];
  if (height === 1) transactions.push(upgradeToV2, upgradeToV3);
  if (height % 25 === 0) {
    transferNonce += 1;
    transactions.push(transfer(transferNonce, height, canonical.protocolVersionAt(height)));
  }

  const round = height % 11 === 0 ? 1 : 0;
  if (round === 1) viewChanges += 1;
  const timestampMs = genesis.timestampMs + (height * 1_000);
  const certificate = roundCertificate(canonical, height, round);

  if (height % 13 === 0) {
    const probeIndex = replicas.findIndex((_, index) => index !== partitioned);
    const probe = replicas[probeIndex];
    assert.equal(probe.height, canonical.height);
    let conflicting = canonical.produceBlock([], proposerPrivateKey(height, round), {
      round,
      roundCertificate: certificate,
      timestampMs: timestampMs + 1
    });
    conflicting = canonical.attestBlock(conflicting, validatorPrivateKeys[0]);
    conflicting = canonical.attestBlock(conflicting, validatorPrivateKeys[1]);
    assert.throws(
      () => probe.validateFinalizedBlock(conflicting, timestampMs + 1),
      /finality|quorum/i,
      `Height ${height}: two signatures unexpectedly satisfied four-validator finality`
    );
    insufficientFinalityRejections += 1;
  }

  if (height % 29 === 0) {
    const probeIndex = replicas.findIndex((_, index) => index !== partitioned);
    const probe = replicas[probeIndex];
    let duplicate = canonical.produceBlock(transactions, proposerPrivateKey(height, round), {
      round,
      roundCertificate: certificate,
      timestampMs: timestampMs + 2
    });
    duplicate = canonical.attestBlock(duplicate, validatorPrivateKeys[0]);
    duplicate.attestations.push(structuredClone(duplicate.attestations[0]));
    duplicate.attestations.push({
      ...canonical.attestBlock(duplicate, validatorPrivateKeys[1]).attestations.at(-1)
    });
    assert.throws(
      () => probe.validateFinalizedBlock(duplicate, timestampMs + 2),
      /duplicate|finality|attestation/i,
      `Height ${height}: duplicate finality voter was not rejected`
    );
    duplicateAttestationRejections += 1;
  }

  const block = finalizedBlock(canonical, height, transactions, round, timestampMs);
  canonical.acceptBlock(block, timestampMs);
  history.push(structuredClone(block));

  for (let index = 0; index < replicas.length; index += 1) {
    if (index === partitioned) {
      partitionedDeliveries += 1;
      continue;
    }
    replicas[index].acceptBlock(structuredClone(block), timestampMs);
  }

  if (height % 17 === 0) {
    const probeIndex = replicas.findIndex((_, index) => index !== partitioned);
    const probe = replicas[probeIndex];
    assert.throws(
      () => probe.validateFinalizedBlock(structuredClone(block), timestampMs),
      /height|previous|hash/i,
      `Height ${height}: finalized replay was accepted twice`
    );
    replayRejections += 1;
  }

  if (height % 37 === 0 && height < TOTAL_HEIGHTS) {
    const nextHeight = height + 1;
    const futureTimestamp = canonical.tip.header.timestampMs + 120_001;
    const future = canonical.produceBlock([], proposerPrivateKey(nextHeight, 0), { timestampMs: futureTimestamp });
    const probeIndex = replicas.findIndex((_, index) => index !== partitioned);
    const probe = replicas[probeIndex];
    assert.throws(
      () => probe.validateProposal(future, canonical.tip.header.timestampMs),
      /future/i,
      `Height ${height}: future-skewed proposal was accepted`
    );
    futureClockRejections += 1;
  }

  if (height % 75 === 0) {
    const restartIndex = replicas.findIndex((replica, index) => index !== partitioned && replica.height === canonical.height);
    assert.notEqual(restartIndex, -1, `Height ${height}: no synchronized replica available for restart rehearsal`);
    const snapshot = replicas[restartIndex].snapshot();
    replicas[restartIndex] = ZyronChain.fromTrustedSnapshot(genesis, snapshot, {
      tipHash: snapshot.tip.hash,
      snapshotSha256: sha256Hex(canonicalJson(snapshot))
    });
    assertConverged(canonical, replicas[restartIndex], `restart at height ${height}`);
    restartRecoveries += 1;
  }

  if (height % 40 === 0) {
    for (let index = 0; index < replicas.length; index += 1) {
      if (index === partitioned) continue;
      assertConverged(canonical, replicas[index], `active replica ${index} at height ${height}`);
    }
  }
}

for (let index = 0; index < replicas.length; index += 1) {
  catchUpReplica(index);
  assertConverged(canonical, replicas[index], `final replica ${index}`);
}

assert.equal(canonical.protocolVersionAt(100), 1);
assert.equal(canonical.protocolVersionAt(101), 2);
assert.equal(canonical.protocolVersionAt(200), 2);
assert.equal(canonical.protocolVersionAt(201), 3);
assert.equal(canonical.protocolVersionAt(TOTAL_HEIGHTS), 3);
assert.equal(canonical.balance(bob), 240);
assert.equal(canonical.nonce(alice), 24);
assert.ok(viewChanges >= 50);
assert.ok(insufficientFinalityRejections >= 40);
assert.ok(duplicateAttestationRejections >= 20);
assert.ok(replayRejections >= 30);
assert.ok(futureClockRejections >= 15);
assert.equal(restartRecoveries, 8);
assert.ok(partitionedDeliveries >= 80);

console.log(JSON.stringify({
  status: "ok",
  finalHeight: canonical.height,
  finalProtocolVersion: canonical.protocolVersionAt(canonical.height),
  finalTipHash: canonical.tip.hash,
  finalStateRoot: canonical.tip.header.stateRoot,
  viewChanges,
  insufficientFinalityRejections,
  duplicateAttestationRejections,
  replayRejections,
  futureClockRejections,
  restartRecoveries,
  partitionedDeliveries
}, null, 2));
