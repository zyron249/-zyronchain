import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { nativeConsensusResponseMaxBytes, validateConsensusResponseResultShape } from "../src/p2p-consensus.js";

const publicKey = publicKeyFromPrivate("01".padStart(64, "0"));
const validator = addressFromPublicKey(publicKey);
const signature = "11".repeat(64);

test("native consensus response byte ceilings match fixed accepted result shapes", () => {
  assert.equal(nativeConsensusResponseMaxBytes("attest"), 8 * 1024);
  assert.equal(nativeConsensusResponseMaxBytes("skip"), 16 * 1024);
  assert.equal(nativeConsensusResponseMaxBytes("block"), 4 * 1024);
  assert.equal(nativeConsensusResponseMaxBytes("transaction"), 4 * 1024);
  for (const kind of ["attest", "skip", "block", "transaction"] as const) {
    assert.ok(nativeConsensusResponseMaxBytes(kind) < 2_500_000, `${kind} response must not use block-sized frame ceiling`);
  }
});

test("native consensus server writes responses with the fixed-shape response ceiling", () => {
  const source = readFileSync(resolve(process.cwd(), "src/p2p-consensus.ts"), "utf8");
  assert.match(source, /satisfies ConsensusResponse, nativeConsensusResponseMaxBytes\(request\.kind\), P2P_CONSENSUS_TIMEOUT_MS\)/);
  assert.doesNotMatch(source, /satisfies ConsensusResponse, MAX_CONSENSUS_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS\)/);
});

test("native consensus response shape gate accepts bounded canonical result shapes", () => {
  assert.doesNotThrow(() => validateConsensusResponseResultShape("attest", {
    validator,
    publicKey,
    signature
  }));
  assert.doesNotThrow(() => validateConsensusResponseResultShape("skip", {
    validator,
    publicKey,
    chainId: "zyron-response-shape-1",
    height: 2,
    round: 1,
    previousHash: "22".repeat(32),
    signature
  }));
  assert.doesNotThrow(() => validateConsensusResponseResultShape("block", { accepted: true }));
  assert.doesNotThrow(() => validateConsensusResponseResultShape("transaction", { txid: "33".repeat(32) }));
});

test("native consensus response shape gate rejects nested or extra peer-controlled result data", () => {
  assert.throws(() => validateConsensusResponseResultShape("attest", {
    validator,
    publicKey,
    signature,
    retained: Array.from({ length: 10_000 }, (_, index) => ({ index }))
  }), /fields/);
  assert.throws(() => validateConsensusResponseResultShape("skip", {
    validator,
    publicKey,
    chainId: "zyron-response-shape-1",
    height: 2,
    round: 1,
    previousHash: "22".repeat(32),
    signature,
    retained: { nested: [1, 2, 3] }
  }), /fields/);
  assert.throws(() => validateConsensusResponseResultShape("block", {
    accepted: true,
    retained: "x".repeat(100_000)
  }), /fields/);
  assert.throws(() => validateConsensusResponseResultShape("transaction", {
    txid: "33".repeat(32),
    retained: ["x"]
  }), /fields/);
});

test("native consensus response shape gate rejects malformed consensus primitives", () => {
  assert.throws(() => validateConsensusResponseResultShape("attest", {
    validator,
    publicKey: "00",
    signature
  }), /public key/);
  assert.throws(() => validateConsensusResponseResultShape("skip", {
    validator,
    publicKey,
    chainId: "x".repeat(129),
    height: 2,
    round: 0,
    previousHash: "22".repeat(32),
    signature
  }), /Invalid native consensus skip result/);
  assert.throws(() => validateConsensusResponseResultShape("block", { accepted: false }), /Invalid native consensus block result/);
  assert.throws(() => validateConsensusResponseResultShape("transaction", { txid: "00" }), /txid/);
});
