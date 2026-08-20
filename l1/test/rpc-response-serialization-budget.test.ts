import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_SMALL_RPC_RESPONSE_SERIALIZATION_BYTES,
  RpcResponseBudgetError,
  RpcResponseByteBudget,
  serializeRpcJsonWithBudget
} from "../src/node-base.js";

const sourceUrl = new URL("../../src/node-base.ts", import.meta.url);

test("RPC response serialization reserves capacity before JSON.stringify", () => {
  const budget = new RpcResponseByteBudget(1_000);
  const releaseHeld = budget.reserve(900);
  let stringified = false;
  assert.throws(() => serializeRpcJsonWithBudget({
    toJSON() {
      stringified = true;
      return { ok: true };
    }
  }, budget, 200), RpcResponseBudgetError);
  assert.equal(stringified, false);
  assert.equal(budget.metrics().responseBytesInUse, 900);
  releaseHeld();
  assert.equal(budget.metrics().responseBytesInUse, 0);
});

test("RPC response serialization shrinks the transient reservation to retained body bytes", () => {
  const budget = new RpcResponseByteBudget(1_000);
  const serialized = serializeRpcJsonWithBudget({ ok: true }, budget, 500);
  assert.equal(serialized.body, '{"ok":true}');
  assert.equal(budget.metrics().responseBytesInUse, serialized.bodyBytes);
  serialized.release();
  serialized.release();
  assert.equal(budget.metrics().responseBytesInUse, 0);
});

test("RPC response serialization releases transient capacity on stringify failure", () => {
  const budget = new RpcResponseByteBudget(1_000);
  assert.throws(() => serializeRpcJsonWithBudget({ value: 1n }, budget, 500), /BigInt/);
  assert.equal(budget.metrics().responseBytesInUse, 0);
  const release = budget.reserve(1_000);
  release();
});

test("RPC response serialization fails closed when a route upper bound is underestimated", () => {
  const budget = new RpcResponseByteBudget(2_000);
  assert.throws(
    () => serializeRpcJsonWithBudget({ payload: "x".repeat(256) }, budget, 64),
    /pre-serialization byte allowance/
  );
  assert.equal(budget.metrics().responseBytesInUse, 0);
});

test("writeJson retains committed body accounting and gives block sync the large-response bound", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.equal(source.includes('response.once("finish", release);'), true);
  assert.equal(source.includes('response.once("close", release);'), true);
  assert.equal(
    source.includes('return writeJson(response, 200, { blocks: await service.blocks(from, limit) }, MAX_SYNC_RESPONSE_BYTES);'),
    true
  );
  assert.equal(source.includes('const overload = JSON.stringify({ error: "Aggregate RPC response byte budget exceeded" });'), false);
  assert.equal(MAX_SMALL_RPC_RESPONSE_SERIALIZATION_BYTES, 4_000_000);
});
