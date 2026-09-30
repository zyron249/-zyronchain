import assert from "node:assert/strict";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { attestationPayload, roundSkipPayload } from "../src/block.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import {
  addressFromPublicKey,
  generatePrivateKey,
  publicKeyFromPrivate,
  signCanonical,
  signCanonicalDomain,
  verifyCanonical,
  verifyCanonicalDomain
} from "../src/crypto.js";
import { preparePayload, viewChangePayload } from "../src/round-view-change.js";
import {
  createTransfer,
  protocolUpgradeApprovalPayload,
  validateTransactionShape,
  validatorUpdateApprovalPayload
} from "../src/transaction.js";
import type { Block } from "../src/types.js";

/** Pass-2 characterization of the signature layer (ZC-CRY-20260930 review). */

const N = secp256k1.Point.CURVE().n;
const priv = "61".padStart(64, "0");
const pub = publicKeyFromPrivate(priv);
const sender = addressFromPublicKey(pub);
const receiver = addressFromPublicKey(publicKeyFromPrivate("62".padStart(64, "0")));

function flipS(signatureHex: string): string {
  const r = signatureHex.slice(0, 64);
  const s = BigInt(`0x${signatureHex.slice(64)}`);
  return r + (N - s).toString(16).padStart(64, "0");
}

test("CRYPTO-REVIEW: signatures are deterministic low-S and the high-S twin is rejected", () => {
  const payload = { a: 1, b: "x" };
  const sig = signCanonical(payload, priv);
  assert.equal(sig, signCanonical(payload, priv), "RFC6979 deterministic");
  assert.ok(BigInt(`0x${sig.slice(64)}`) <= N / 2n, "low-S");
  assert.equal(verifyCanonical(payload, sig, pub), true);
  assert.equal(verifyCanonical(payload, flipS(sig), pub), false, "malleated high-S must fail");
});

test("CRYPTO-REVIEW: degenerate signatures and invalid public keys are rejected", () => {
  const payload = { a: 1 };
  const sig = signCanonical(payload, priv);
  assert.equal(verifyCanonical(payload, "00".repeat(64), pub), false);
  assert.equal(verifyCanonical(payload, sig.slice(0, 64) + "00".repeat(32), pub), false);
  assert.equal(verifyCanonical(payload, N.toString(16).padStart(64, "0") + sig.slice(64), pub), false, "r = n");
  assert.equal(verifyCanonical(payload, sig, "00".repeat(64)), false, "point at infinity / off-curve");
  const offCurve = pub.slice(0, 127) + (pub[127] === "0" ? "1" : "0");
  assert.equal(verifyCanonical(payload, sig, offCurve), false, "off-curve y");
});

test("CRYPTO-REVIEW: domain-separated signatures do not verify across domains or bare", () => {
  const payload = { chainId: "c", height: 1 };
  const sig = signCanonicalDomain("zyronchain/round-prepare/v1", payload, priv);
  assert.equal(verifyCanonicalDomain("zyronchain/round-prepare/v1", payload, sig, pub), true);
  assert.equal(verifyCanonicalDomain("zyronchain/round-view-change/v1", payload, sig, pub), false);
  assert.equal(verifyCanonical(payload, sig, pub), false);
  assert.throws(() => signCanonicalDomain("evil/domain", payload, priv), /Invalid canonical signing domain/);
});

test("CRYPTO-REVIEW: transaction signature binds chainId and rejects non-canonical hex and high-S twins", () => {
  const tx = createTransfer({
    chainId: "zyron-sig-review-1", nonce: 1, sender, receiver, amountAtoms: 5, feeAtoms: 1, timestampMs: 1
  }, priv, pub, 2);
  assert.doesNotThrow(() => validateTransactionShape(structuredClone(tx)));
  assert.throws(() => validateTransactionShape({ ...tx, chainId: "zyron-sig-review-2" }));
  assert.throws(() => validateTransactionShape({ ...tx, signature: tx.signature.toUpperCase() }), /lowercase hex/);
  assert.throws(() => validateTransactionShape({ ...tx, signature: `${tx.signature}0` }), /lowercase hex/);
  assert.throws(() => validateTransactionShape({ ...tx, publicKey: tx.publicKey.toUpperCase() }), /lowercase hex/);
  // A high-S twin with a recomputed txid must still be rejected (no txid malleability).
  const { txid: _txid, ...unsignedTwin } = { ...tx, signature: flipS(tx.signature) };
  const twin = { ...unsignedTwin, txid: sha256Hex(canonicalJson(unsignedTwin)) };
  assert.throws(() => validateTransactionShape(twin), /Invalid transaction signature/);
});

test("CRYPTO-REVIEW: undomained protocol v1/v2 signed payload shapes are pairwise distinct", () => {
  const header = {
    version: 1, chainId: "c", height: 1, round: 0, previousHash: "0".repeat(64), timestampMs: 1,
    transactionRoot: "0".repeat(64), stateRoot: "0".repeat(64), proposer: sender
  };
  const block = { header, hash: "1".repeat(64) } as unknown as Block;
  const tx = createTransfer({ chainId: "c", nonce: 1, sender, receiver, amountAtoms: 1, feeAtoms: 0, timestampMs: 1 }, priv, pub, 1);
  const { signature: _s, txid: _t, ...txPayload } = tx;
  const shapes: Record<string, unknown> = {
    header,
    attestation: attestationPayload(block),
    skip: roundSkipPayload({ validator: sender, publicKey: pub, chainId: "c", height: 1, round: 0, previousHash: "0".repeat(64) }),
    prepare: preparePayload({ validator: sender, publicKey: pub, chainId: "c", height: 1, round: 0, blockHash: "1".repeat(64) }),
    viewChange: viewChangePayload({
      validator: sender, publicKey: pub, chainId: "c", height: 1, round: 0, previousHash: "0".repeat(64), lockRound: null, lockHash: null
    } as Parameters<typeof viewChangePayload>[0]),
    transfer: txPayload,
    validatorApproval: validatorUpdateApprovalPayload({ chainId: "c", nonce: 1, sender, activationHeight: 2, validators: [] }),
    protocolApproval: protocolUpgradeApprovalPayload({ chainId: "c", nonce: 1, sender, activationHeight: 2, protocolVersion: 5 })
  };
  const keySets = Object.entries(shapes).map(([name, value]) => [name, Object.keys(JSON.parse(canonicalJson(value))).join(",")]);
  const seen = new Map<string, string>();
  for (const [name, keys] of keySets) {
    assert.ok(!seen.has(keys!), `${name} collides with ${seen.get(keys!)}`);
    seen.set(keys!, name!);
  }
});

test("CRYPTO-REVIEW: generated keys come from the CSPRNG and are valid scalars", () => {
  const keys = new Set(Array.from({ length: 64 }, () => generatePrivateKey()));
  assert.equal(keys.size, 64);
  for (const key of keys) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(secp256k1.utils.isValidSecretKey(Buffer.from(key, "hex")));
  }
});
