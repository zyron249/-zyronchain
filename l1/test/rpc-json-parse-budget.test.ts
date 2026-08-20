import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RPC_JSON_NESTING_DEPTH,
  MAX_RPC_JSON_STRUCTURAL_TOKENS,
  RpcRequestBodyByteBudget,
  RpcRequestBodyReservation,
  assertBoundedRpcJsonStructure,
  parseRpcJsonChunks
} from "../src/node.js";

test("RPC JSON complexity accepts exact nesting bound and rejects bound plus one", () => {
  const exact = Buffer.from("[".repeat(MAX_RPC_JSON_NESTING_DEPTH) + "0" + "]".repeat(MAX_RPC_JSON_NESTING_DEPTH));
  assert.doesNotThrow(() => assertBoundedRpcJsonStructure(exact));

  const over = Buffer.from("[".repeat(MAX_RPC_JSON_NESTING_DEPTH + 1) + "0" + "]".repeat(MAX_RPC_JSON_NESTING_DEPTH + 1));
  assert.throws(() => assertBoundedRpcJsonStructure(over), /RPC request JSON complexity exceeded/);
});

test("RPC JSON complexity bounds structural cardinality without counting punctuation inside strings", () => {
  // A flat array with N elements has N+1 structural tokens: '[' + ']' + N-1 commas.
  const exactElements = MAX_RPC_JSON_STRUCTURAL_TOKENS - 1;
  const exact = Buffer.from(`[${Array(exactElements).fill("0").join(",")}]`);
  assert.doesNotThrow(() => assertBoundedRpcJsonStructure(exact));

  const overElements = MAX_RPC_JSON_STRUCTURAL_TOKENS;
  const over = Buffer.from(`[${Array(overElements).fill("0").join(",")}]`);
  assert.throws(() => assertBoundedRpcJsonStructure(over), /RPC request JSON complexity exceeded/);

  const punctuationInString = Buffer.from(JSON.stringify({ value: "[{,:]}\\\"".repeat(10_000) }));
  assert.doesNotThrow(() => assertBoundedRpcJsonStructure(punctuationInString));
});

test("RPC JSON parse transient capacity fails closed and is reclaimed", () => {
  const budget = new RpcRequestBodyByteBudget(700);
  const first = new RpcRequestBodyReservation(budget);
  const second = new RpcRequestBodyReservation(budget);
  const firstBody = Buffer.from(JSON.stringify({ value: "x".repeat(150) }));
  const secondBody = Buffer.from(JSON.stringify({ value: "y".repeat(150) }));

  first.reserve(firstBody.length);
  second.reserve(secondBody.length);
  const before = budget.metrics().requestBodyBytesInUse;

  assert.throws(
    () => parseRpcJsonChunks([firstBody], firstBody.length, first),
    /Aggregate RPC request body byte budget exceeded/
  );
  assert.equal(budget.metrics().requestBodyBytesInUse, before);

  second.release();
  assert.deepEqual(parseRpcJsonChunks([firstBody], firstBody.length, first), { value: "x".repeat(150) });
  assert.equal(budget.metrics().requestBodyBytesInUse, firstBody.length);
  first.release();
  assert.equal(budget.metrics().requestBodyBytesInUse, 0);
});

test("invalid RPC JSON releases all transient parse reservations", () => {
  const body = Buffer.from('{"broken":');
  const budget = new RpcRequestBodyByteBudget(10_000);
  const reservation = new RpcRequestBodyReservation(budget);
  reservation.reserve(body.length);
  const retained = budget.metrics().requestBodyBytesInUse;

  assert.throws(() => parseRpcJsonChunks([body], body.length, reservation), SyntaxError);
  assert.equal(budget.metrics().requestBodyBytesInUse, retained);

  reservation.release();
  assert.equal(budget.metrics().requestBodyBytesInUse, 0);
});
