import assert from "node:assert/strict";
import test from "node:test";
import type { Stream } from "@libp2p/interface";

import {
  MAX_P2P_JSON_NESTING_DEPTH,
  MAX_P2P_JSON_STRUCTURAL_TOKENS,
  P2PFrameByteBudget,
  readP2PFrame,
  readP2PFrameRetained
} from "../src/p2p-frame.js";

function framed(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

test("native frame decoder accepts JSON at the nesting-depth boundary", async () => {
  const json = "[".repeat(MAX_P2P_JSON_NESTING_DEPTH) + "0" + "]".repeat(MAX_P2P_JSON_NESTING_DEPTH);
  const value = await readP2PFrame(fakeReadableStream([framed(json)]), 4_096, 1_000);
  let cursor: unknown = value;
  for (let depth = 0; depth < MAX_P2P_JSON_NESTING_DEPTH; depth += 1) {
    assert.ok(Array.isArray(cursor));
    cursor = cursor[0];
  }
  assert.equal(cursor, 0);
});

test("native frame decoder rejects JSON above the nesting-depth boundary before parse", async () => {
  const json = "[".repeat(MAX_P2P_JSON_NESTING_DEPTH + 1) + "0" + "]".repeat(MAX_P2P_JSON_NESTING_DEPTH + 1);
  const budget = new P2PFrameByteBudget(8_192);
  await assert.rejects(
    () => readP2PFrameRetained(fakeReadableStream([framed(json)]), 4_096, 1_000, budget),
    /JSON complexity exceeded/
  );
  assert.equal(budget.metrics().bytesInUse, 0);
});

test("native frame decoder rejects excessive structural-token cardinality and releases reservations", async () => {
  const elements = Math.floor(MAX_P2P_JSON_STRUCTURAL_TOKENS / 2) + 2;
  const json = `[${Array.from({ length: elements }, () => "0").join(",")}]`;
  const bodyBytes = Buffer.byteLength(json);
  const budget = new P2PFrameByteBudget(bodyBytes * 2 + 64);
  await assert.rejects(
    () => readP2PFrameRetained(fakeReadableStream([framed(json)]), bodyBytes + 16, 1_000, budget),
    /JSON complexity exceeded/
  );
  assert.equal(budget.metrics().bytesInUse, 0);
});

test("JSON complexity scanner ignores punctuation and escaped quotes inside strings", async () => {
  const noisy = "[{,:]}\\\"".repeat(2_000);
  const json = JSON.stringify({ value: noisy });
  assert.deepEqual(
    await readP2PFrame(fakeReadableStream([framed(json)]), Buffer.byteLength(json) + 16, 1_000),
    { value: noisy }
  );
});

function fakeReadableStream(chunks: readonly Uint8Array[]): Stream {
  return {
    inactivityTimeout: 0,
    abort() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  } as unknown as Stream;
}
