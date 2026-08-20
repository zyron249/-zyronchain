#!/usr/bin/env node
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';

import { assertJsonComplexity, readBoundedJsonResponse } from './miner-rpc-response.mjs';

function responseFromChunks(chunks, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    }
  }), { headers });
}

{
  const raw = '{"ok":true}';
  const result = await readBoundedJsonResponse(responseFromChunks(['{"ok":', 'true}'], {
    'content-length': String(Buffer.byteLength(raw))
  }), 1024);
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.text, raw);
}

await assert.rejects(
  readBoundedJsonResponse(responseFromChunks(['{}'], { 'content-length': '02' }), 1024),
  /invalid Content-Length/
);
await assert.rejects(
  readBoundedJsonResponse(responseFromChunks(['{}'], { 'content-length': '3' }), 1024),
  /length mismatch/
);
await assert.rejects(
  readBoundedJsonResponse(responseFromChunks(['{"x":"', 'a'.repeat(64), '"}']), 32),
  /exceeds 32 byte limit/
);

{
  const exactDepth = `${'['.repeat(64)}0${']'.repeat(64)}`;
  assert.doesNotThrow(() => assertJsonComplexity(Buffer.from(exactDepth)));
  const tooDeep = `${'['.repeat(65)}0${']'.repeat(65)}`;
  assert.throws(() => assertJsonComplexity(Buffer.from(tooDeep)), /nesting limit exceeded/);
}

{
  const punctuationInString = JSON.stringify({ value: '{[,:]}\\"'.repeat(100) });
  assert.doesNotThrow(() => assertJsonComplexity(Buffer.from(punctuationInString), 64, 10));
}

{
  const many = `[${Array.from({ length: 11 }, () => '0').join(',')}]`;
  assert.throws(() => assertJsonComplexity(Buffer.from(many), 64, 10), /structural-token limit exceeded/);
}

await assert.rejects(
  readBoundedJsonResponse(responseFromChunks(['{"broken":']), 1024),
  /invalid JSON/
);

console.log('miner RPC response parser regressions passed');
