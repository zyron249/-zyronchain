// F-05: validator public keys must be valid secp256k1 points at every
// membership boundary (genesis, validator_update, checkpoint schedule). An
// off-curve key whose address hash matches still counts toward the quorum
// denominator but can never sign, silently lowering fault tolerance.
// F-06: block-template selection must advance the governance activation
// cursors only for transactions it actually selects. A governance
// transaction skipped for size or a failed state transition must not exclude
// a later valid one with a lower activation height.
import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, isValidPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { validateLightClientAnchor } from "../src/light-client.js";
import {
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createValidatorApproval,
  createValidatorSetUpdate
} from "../src/transaction.js";
import type { GenesisConfig, Validator } from "../src/types.js";

const key = (n: number) => n.toString(16).padStart(64, "0");
const oneKey = key(1);
const twoKey = key(2);
const onePublic = publicKeyFromPrivate(oneKey);
const twoPublic = publicKeyFromPrivate(twoKey);
const one = addressFromPublicKey(onePublic);
const two = addressFromPublicKey(twoPublic);
const oraclePublic = publicKeyFromPrivate(key(4));
const pool = addressFromPublicKey(publicKeyFromPrivate(key(6)));
const T0 = 1_700_000_000_000;

function validator(n: number): Validator {
  const publicKey = publicKeyFromPrivate(key(n));
  return { address: addressFromPublicKey(publicKey), publicKey };
}

// 64-byte x||y with the y coordinate changed: hex-valid, address-consistent,
// not a curve point.
function offCurveValidator(): Validator {
  const valid = publicKeyFromPrivate(key(9));
  const last = (parseInt(valid.slice(-2), 16) ^ 1).toString(16).padStart(2, "0");
  const publicKey = valid.slice(0, -2) + last;
  return { address: addressFromPublicKey(publicKey), publicKey };
}

function genesis(validators: Validator[] = [{ address: one, publicKey: onePublic }, { address: two, publicKey: twoPublic }]): GenesisConfig {
  return {
    chainId: "zyron-f05-test",
    timestampMs: T0,
    validators,
    activityOracles: [oraclePublic],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 5_000_000_000 }]
  };
}

function validatorUpdate(sender: "one" | "two", nonce: number, activationHeight: number, validators: Validator[]) {
  const senderKey = sender === "one" ? oneKey : twoKey;
  const senderPublic = sender === "one" ? onePublic : twoPublic;
  const input = { chainId: genesis().chainId, nonce, sender: addressFromPublicKey(senderPublic), activationHeight, validators };
  const approvals = [
    createValidatorApproval(input, oneKey, onePublic),
    createValidatorApproval(input, twoKey, twoPublic)
  ];
  return createValidatorSetUpdate({ ...input, approvals, timestampMs: T0 + 10 }, senderKey, senderPublic);
}

function protocolUpgrade(sender: "one" | "two", nonce: number, activationHeight: number) {
  const senderKey = sender === "one" ? oneKey : twoKey;
  const senderPublic = sender === "one" ? onePublic : twoPublic;
  const proposal = { chainId: genesis().chainId, nonce, sender: addressFromPublicKey(senderPublic), activationHeight, protocolVersion: 2 };
  return createProtocolUpgrade({
    ...proposal,
    approvals: [
      createProtocolUpgradeApproval(proposal, oneKey, onePublic),
      createProtocolUpgradeApproval(proposal, twoKey, twoPublic)
    ],
    timestampMs: T0 + 10
  }, senderKey, senderPublic);
}

// Senders ordered as selectValidPending orders them (by address).
const firstSender: "one" | "two" = one < two ? "one" : "two";
const secondSender: "one" | "two" = one < two ? "two" : "one";

test("F-05: genesis rejects an off-curve validator key whose address matches", () => {
  const bad = offCurveValidator();
  assert.throws(() => new ZyronChain(genesis([{ address: one, publicKey: onePublic }, bad])), /not a valid secp256k1 point/);
  assert.doesNotThrow(() => new ZyronChain(genesis()));
});

test("F-05: a validator_update carrying an off-curve key is rejected", () => {
  const chain = new ZyronChain(genesis());
  const update = validatorUpdate("one", 1, 150, [validator(7), offCurveValidator()]);
  assert.deepEqual(chain.selectValidPending([update], 10), []);
  assert.throws(() => chain.produceBlock([update], oneKey, { timestampMs: T0 + 100 }), /not a valid secp256k1 point/);
  const good = validatorUpdate("one", 1, 150, [validator(7), validator(8)]);
  assert.equal(chain.selectValidPending([good], 10).length, 1);
});

test("F-05: a trusted checkpoint schedule with an off-curve key is rejected", () => {
  const chain = new ZyronChain(genesis());
  const snapshot = structuredClone(chain.snapshot()) as unknown as Record<string, unknown>;
  const goodSchedule = [...(snapshot.validatorSchedule as unknown[]), { activationHeight: 200, validators: [validator(7), validator(8)] }];
  const badSchedule = [...(snapshot.validatorSchedule as unknown[]), { activationHeight: 200, validators: [validator(7), offCurveValidator()] }];
  const open = (schedule: unknown[]) => {
    const value = { ...snapshot, validatorSchedule: schedule };
    return ZyronChain.fromTrustedSnapshot(genesis(), value, {
      tipHash: chain.tip.hash,
      snapshotSha256: sha256Hex(canonicalJson(value))
    });
  };
  assert.doesNotThrow(() => open(goodSchedule));
  assert.throws(() => open(badSchedule), /not a valid secp256k1 point|Invalid checkpoint validator/);
});

test("F-05: light-client anchors refuse off-curve validator keys, and the key predicate is strict", () => {
  const anchor = {
    version: 1,
    chainId: "zyron-f05-test",
    genesisHash: "11".repeat(32),
    height: 100,
    blockHash: "22".repeat(32),
    stateRoot: "33".repeat(32),
    timestampMs: T0,
    protocolVersion: 5,
    validators: [validator(7), validator(8)]
  };
  assert.doesNotThrow(() => validateLightClientAnchor(anchor));
  assert.throws(() => validateLightClientAnchor({ ...anchor, validators: [validator(7), offCurveValidator()] }), /not a valid secp256k1 point/);
  assert.equal(isValidPublicKey(onePublic), true);
  assert.equal(isValidPublicKey(offCurveValidator().publicKey), false);
  assert.equal(isValidPublicKey("00".repeat(64)), false);
  assert.equal(isValidPublicKey(onePublic.toUpperCase()), false);
  assert.equal(isValidPublicKey(onePublic.slice(0, 64)), false);
});

test("F-06: a validator_update skipped for size does not exclude a later valid one", () => {
  const chain = new ZyronChain(genesis());
  const many = Array.from({ length: 60 }, (_, index) => validator(100 + index));
  const big = validatorUpdate(firstSender, 1, 300, many);
  const small = validatorUpdate(secondSender, 1, 250, [validator(7), validator(8)]);
  const budget = Buffer.byteLength(canonicalJson(small), "utf8") + 10;
  assert.ok(Buffer.byteLength(canonicalJson(big), "utf8") > budget);
  const selected = chain.selectValidPending([big, small], 10, budget);
  assert.deepEqual(selected.map((tx) => tx.txid), [small.txid]);
});

test("F-06: a validator_update that fails state application does not exclude a later valid one", () => {
  const chain = new ZyronChain(genesis());
  const gapped = validatorUpdate(firstSender, 5, 300, [validator(7), validator(8)]);
  const valid = validatorUpdate(secondSender, 1, 250, [validator(7), validator(8)]);
  const selected = chain.selectValidPending([gapped, valid], 10);
  assert.deepEqual(selected.map((tx) => tx.txid), [valid.txid]);
  // The selected template is accepted by authoritative validation.
  assert.doesNotThrow(() => chain.produceBlock(selected, oneKey, { timestampMs: T0 + 100 }));
});

test("F-06: a protocol_upgrade that fails state application does not exclude a later valid one", () => {
  const chain = new ZyronChain(genesis());
  const gapped = protocolUpgrade(firstSender, 5, 300);
  const valid = protocolUpgrade(secondSender, 1, 250);
  const selected = chain.selectValidPending([gapped, valid], 10);
  assert.deepEqual(selected.map((tx) => tx.txid), [valid.txid]);
});
