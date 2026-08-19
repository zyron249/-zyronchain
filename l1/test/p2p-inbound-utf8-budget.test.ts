import assert from "node:assert/strict";
import test from "node:test";
import type { Stream } from "@libp2p/interface";

import { P2PFrameByteBudget, readP2PFrameRetained } from "../src/p2p-frame.js";

test("inbound frame decoder triple-accounts UTF-8 parse transient and retains encoded plus decoded capacity", async () => {
  const body = Buffer.from("{}");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const budget = new P2PFrameByteBudget(body.length * 3);

  const retained = await readP2PFrameRetained(fakeReadableStream([header, body]), 32, 1_000, budget);
  assert.deepEqual(retained.value, {});
  assert.equal(budget.metrics().peakBytesInUse, body.length * 3);
  assert.equal(budget.metrics().bytesInUse, body.length * 2);

  retained.release();
  assert.equal(budget.metrics().bytesInUse, 0);
});

test("inbound frame decoder fails closed when transient UTF-8 allowance is unavailable", async () => {
  const body = Buffer.from("{}");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const budget = new P2PFrameByteBudget((body.length * 3) - 1);

  await assert.rejects(
    () => readP2PFrameRetained(fakeReadableStream([header, body]), 32, 1_000, budget),
    /byte budget exceeded/
  );
  assert.equal(budget.metrics().bytesInUse, 0);
  assert.equal(budget.metrics().peakBytesInUse, body.length * 2);
  assert.equal(budget.metrics().rejectedFrames, 1);
});

test("invalid JSON releases encoded decoded and UTF-8 transient allowances", async () => {
  const body = Buffer.from("{");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const budget = new P2PFrameByteBudget(body.length * 3);

  await assert.rejects(
    () => readP2PFrameRetained(fakeReadableStream([header, body]), 32, 1_000, budget),
    /Invalid P2P frame encoding/
  );
  assert.deepEqual(budget.metrics(), {
    bytesInUse: 0,
    maxBytes: body.length * 3,
    peakBytesInUse: body.length * 3,
    rejectedFrames: 0
  });
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
