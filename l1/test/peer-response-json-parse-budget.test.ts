import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PEER_RESPONSE_JSON_NESTING_DEPTH,
  MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS,
  PeerResponseByteBudget,
  assertBoundedPeerResponseJsonStructure,
  parsePeerResponseJsonChunks
} from "../src/node.js";

test("peer response JSON complexity accepts exact nesting and rejects bound plus one", () => {
  const exact = Buffer.from("[".repeat(MAX_PEER_RESPONSE_JSON_NESTING_DEPTH) + "0" + "]".repeat(MAX_PEER_RESPONSE_JSON_NESTING_DEPTH));
  assert.equal(assertBoundedPeerResponseJsonStructure(exact) > 0, true);
  const over = Buffer.from("[".repeat(MAX_PEER_RESPONSE_JSON_NESTING_DEPTH + 1) + "0" + "]".repeat(MAX_PEER_RESPONSE_JSON_NESTING_DEPTH + 1));
  assert.throws(() => assertBoundedPeerResponseJsonStructure(over), /Peer response JSON complexity exceeded/);
});

test("peer response JSON structural cardinality is bounded without counting string punctuation", () => {
  const exactElements = MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS - 1;
  const exact = Buffer.from(`[${Array(exactElements).fill("0").join(",")}]`);
  assert.doesNotThrow(() => assertBoundedPeerResponseJsonStructure(exact));
  const overElements = MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS;
  const over = Buffer.from(`[${Array(overElements).fill("0").join(",")}]`);
  assert.throws(() => assertBoundedPeerResponseJsonStructure(over), /Peer response JSON complexity exceeded/);
  const punctuation = Buffer.from(JSON.stringify({ value: "[{,:]}\\\"".repeat(10_000) }));
  assert.doesNotThrow(() => assertBoundedPeerResponseJsonStructure(punctuation));
});

test("peer response parse budget rejects concurrent amplification and retains decoded ownership capacity", () => {
  const firstBody = Buffer.from(JSON.stringify({ value: "x".repeat(200) }));
  const secondBody = Buffer.from(JSON.stringify({ value: "y".repeat(200) }));
  const probe = new PeerResponseByteBudget(100_000);
  const first = parsePeerResponseJsonChunks([firstBody], firstBody.length, probe);
  assert.deepEqual(first.value, { value: "x".repeat(200) });
  const retained = probe.inUseBytes;
  assert.equal(retained > 0, true);

  const constrained = new PeerResponseByteBudget(retained + (secondBody.length * 3) - 1);
  const held = parsePeerResponseJsonChunks([firstBody], firstBody.length, constrained);
  assert.throws(
    () => parsePeerResponseJsonChunks([secondBody], secondBody.length, constrained),
    /Aggregate peer response byte budget exceeded/
  );
  held.release();
  assert.equal(constrained.inUseBytes, 0);
  first.release();
  assert.equal(probe.inUseBytes, 0);
});

test("invalid peer response JSON releases transient and decoded parse capacity", () => {
  const budget = new PeerResponseByteBudget(100_000);
  const invalid = Buffer.from('{"broken":');
  assert.throws(() => parsePeerResponseJsonChunks([invalid], invalid.length, budget), SyntaxError);
  assert.equal(budget.inUseBytes, 0);
});
