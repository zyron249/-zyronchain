import assert from "node:assert/strict";
import test from "node:test";
import type { Stream } from "@libp2p/interface";

import { P2PFrameByteBudget, readP2PFrame, readP2PFrameRetained, writeP2PFrame } from "../src/p2p-frame.js";

test("native frame decoder is invariant to adversarial transport fragmentation", async () => {
  const value = {
    version: 1,
    text: "zyron".repeat(97),
    values: Array.from({ length: 32 }, (_, index) => index * 17)
  };
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const framed = Buffer.concat([header, body]);
  let seed = 0x5eed1234;
  for (let iteration = 0; iteration < 250; iteration += 1) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < framed.length;) {
      seed = ((seed * 1664525) + 1013904223) >>> 0;
      const width = 1 + (seed % 37);
      chunks.push(framed.subarray(offset, Math.min(framed.length, offset + width)));
      offset += width;
    }
    assert.deepEqual(await readP2PFrame(fakeReadableStream(chunks), 16_384, 1_000), value);
  }
});

test("native frame decoder fails closed on oversized, truncated and trailing data", async () => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(65_536);
  await assert.rejects(() => readP2PFrame(fakeReadableStream([oversized]), 1_024, 1_000), /frame length/);

  const truncated = Buffer.alloc(6);
  truncated.writeUInt32BE(10);
  truncated.write("{}", 4);
  await assert.rejects(() => readP2PFrame(fakeReadableStream([truncated]), 1_024, 1_000), /Truncated/);

  const body = Buffer.from("{}");
  const trailing = Buffer.alloc(4 + body.length + 1);
  trailing.writeUInt32BE(body.length);
  body.copy(trailing, 4);
  trailing[trailing.length - 1] = 0xff;
  await assert.rejects(() => readP2PFrame(fakeReadableStream([trailing]), 1_024, 1_000), /Trailing bytes/);
});

test("native frame decoder rejects allocation-amplifying transport chunks before budget reservation", async () => {
  const maxBytes = 1_024;
  const budget = new P2PFrameByteBudget(maxBytes);
  const chunk = Buffer.alloc(maxBytes + 5);
  chunk.writeUInt32BE(1, 0);
  chunk[4] = 0x7b;

  await assert.rejects(
    () => readP2PFrameRetained(fakeReadableStream([chunk]), maxBytes, 1_000, budget),
    /transport chunk exceeds frame limit/
  );
  assert.deepEqual(budget.metrics(), {
    bytesInUse: 0,
    maxBytes,
    peakBytesInUse: 0,
    rejectedFrames: 0
  });
});

test("native frame decoder bounds aggregate retained body bytes and recovers capacity", async () => {
  const budget = new P2PFrameByteBudget(8);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(8);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = readP2PFrame(fakeReadableStream([header], firstGate), 32, 1_000, budget);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(
    () => readP2PFrame(fakeReadableStream([header]), 32, 1_000, budget),
    /byte budget exceeded/
  );
  assert.deepEqual(budget.metrics(), { bytesInUse: 8, maxBytes: 8, peakBytesInUse: 8, rejectedFrames: 1 });

  releaseFirst();
  await assert.rejects(() => first, /Truncated/);
  assert.deepEqual(budget.metrics(), { bytesInUse: 0, maxBytes: 8, peakBytesInUse: 8, rejectedFrames: 1 });

  const body = Buffer.from("{}");
  const validHeader = Buffer.alloc(4);
  validHeader.writeUInt32BE(body.length);
  assert.deepEqual(
    await readP2PFrame(fakeReadableStream([validHeader, body]), 32, 1_000, budget),
    {}
  );
});

test("retained native frame capacity accounts encoded and decoded value until caller release", async () => {
  const budget = new P2PFrameByteBudget(8);
  const body = Buffer.from("{}");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const retained = await readP2PFrameRetained(fakeReadableStream([header, body]), 8, 1_000, budget);
  assert.deepEqual(retained.value, {});
  assert.equal(budget.metrics().bytesInUse, body.length * 2);

  const competing = Buffer.alloc(4);
  competing.writeUInt32BE(8);
  await assert.rejects(
    () => readP2PFrameRetained(fakeReadableStream([competing]), 8, 1_000, budget),
    /byte budget exceeded/
  );

  retained.release();
  assert.equal(budget.metrics().bytesInUse, 0);
  retained.release();
  assert.equal(budget.metrics().bytesInUse, 0);
});

test("decoded-frame allowance rejects concurrent retained parse and releases failed reservation", async () => {
  const budget = new P2PFrameByteBudget(6);
  const body = Buffer.from("{}");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);

  const first = await readP2PFrameRetained(fakeReadableStream([header, body]), 8, 1_000, budget);
  assert.equal(budget.metrics().bytesInUse, 4);

  await assert.rejects(
    () => readP2PFrameRetained(fakeReadableStream([header, body]), 8, 1_000, budget),
    /byte budget exceeded/
  );
  assert.equal(budget.metrics().bytesInUse, 4, "failed decode reservation must release the competing encoded-body reservation");

  first.release();
  assert.equal(budget.metrics().bytesInUse, 0);
});

test("invalid JSON releases encoded decoded and UTF-8 frame reservations", async () => {
  const budget = new P2PFrameByteBudget(8);
  const body = Buffer.from("{");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);

  await assert.rejects(
    () => readP2PFrameRetained(fakeReadableStream([header, body]), 8, 1_000, budget),
    /Invalid P2P frame encoding/
  );
  assert.equal(budget.metrics().bytesInUse, 0);
  assert.equal(budget.metrics().peakBytesInUse, 3);
});

test("native frame writer releases transient max reservations before slow-reader retention", async () => {
  const budget = new P2PFrameByteBudget(18);
  let drainFirst!: () => void;
  const firstDrain = new Promise<void>((resolve) => { drainFirst = resolve; });
  const first = writeP2PFrame(fakeWritableStream(firstDrain), {}, 8, 1_000, budget);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(budget.metrics(), { bytesInUse: 2, maxBytes: 18, peakBytesInUse: 16, rejectedFrames: 0 });
  await writeP2PFrame(fakeWritableStream(), {}, 8, 1_000, budget);
  assert.deepEqual(budget.metrics(), { bytesInUse: 2, maxBytes: 18, peakBytesInUse: 18, rejectedFrames: 0 });

  drainFirst();
  await first;
  assert.equal(budget.metrics().bytesInUse, 0);
});

test("native frame writer releases all reservations on serialization and oversize failures", async () => {
  const serializationBudget = new P2PFrameByteBudget(16);
  await assert.rejects(
    () => writeP2PFrame(fakeWritableStream(), { value: 1n }, 8, 1_000, serializationBudget),
    TypeError
  );
  assert.deepEqual(serializationBudget.metrics(), { bytesInUse: 0, maxBytes: 16, peakBytesInUse: 16, rejectedFrames: 0 });

  const oversizeBudget = new P2PFrameByteBudget(16);
  await assert.rejects(
    () => writeP2PFrame(fakeWritableStream(), "123456789", 8, 1_000, oversizeBudget),
    /P2P frame too large/
  );
  assert.deepEqual(oversizeBudget.metrics(), { bytesInUse: 0, maxBytes: 16, peakBytesInUse: 16, rejectedFrames: 0 });
});

function fakeWritableStream(drain?: Promise<void>): Stream {
  let blocked = drain !== undefined;
  return {
    inactivityTimeout: 0,
    send() {
      if (!blocked) return true;
      blocked = false;
      return false;
    },
    async onDrain() {
      await drain;
    },
    async close() {}
  } as unknown as Stream;
}

function fakeReadableStream(chunks: readonly Uint8Array[], gate?: Promise<void>): Stream {
  return {
    inactivityTimeout: 0,
    abort() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
      await gate;
    }
  } as unknown as Stream;
}
