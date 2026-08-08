import assert from "node:assert/strict";
import test from "node:test";
import type { Stream } from "@libp2p/interface";

import { readP2PFrame } from "../src/p2p-frame.js";

const MAX_FRAME = 512;

test("fuzz: native frame decoder agrees with an exact-length JSON oracle under arbitrary fragmentation", async () => {
  let seed = 0x51f15eed;
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    seed = next(seed);
    const mode = seed % 4;
    let frame: Buffer;
    if (mode === 0) {
      seed = next(seed);
      const declared = seed % 768;
      seed = next(seed);
      const actual = seed % 768;
      const body = Buffer.alloc(actual);
      for (let index = 0; index < body.length; index += 1) {
        seed = next(seed);
        body[index] = seed & 0xff;
      }
      const header = Buffer.alloc(4);
      header.writeUInt32BE(declared);
      frame = Buffer.concat([header, body]);
    } else {
      seed = next(seed);
      const value = {
        n: seed >>> 0,
        text: `zyron-${(seed & 0xffff).toString(16)}`,
        enabled: (seed & 1) === 0
      };
      const body = Buffer.from(JSON.stringify(value), "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      frame = Buffer.concat([header, body]);
      if (mode === 2) frame = frame.subarray(0, Math.max(0, frame.length - 1));
      if (mode === 3) frame = Buffer.concat([frame, Buffer.from([0xff])]);
    }

    const expected = oracle(frame);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < frame.length;) {
      seed = next(seed);
      const width = 1 + (seed % 29);
      chunks.push(frame.subarray(offset, Math.min(frame.length, offset + width)));
      offset += width;
    }

    if (expected.ok) {
      assert.deepEqual(await readP2PFrame(fakeReadableStream(chunks), MAX_FRAME, 1_000), expected.value);
    } else {
      await assert.rejects(() => readP2PFrame(fakeReadableStream(chunks), MAX_FRAME, 1_000));
    }
  }
});

function oracle(frame: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (frame.length < 4) return { ok: false };
  const length = frame.readUInt32BE(0);
  if (length < 1 || length > MAX_FRAME || frame.length !== 4 + length) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(frame.subarray(4).toString("utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

function fakeReadableStream(chunks: readonly Uint8Array[]): Stream {
  return {
    inactivityTimeout: 0,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  } as unknown as Stream;
}

function next(value: number): number {
  return ((value * 1664525) + 1013904223) >>> 0;
}
