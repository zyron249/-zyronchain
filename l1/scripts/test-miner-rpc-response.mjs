#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ReadableStream } from 'node:stream/web';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertJsonComplexity, readBoundedJsonResponse } from './miner-rpc-response.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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

{
  const response = responseFromChunks(['{"ok":true}']);
  const originalAllocUnsafe = Buffer.allocUnsafe;
  const allocations = [];
  Buffer.allocUnsafe = function trackedAllocUnsafe(size) {
    allocations.push(size);
    return originalAllocUnsafe(size);
  };
  try {
    const result = await readBoundedJsonResponse(response, 64 * 1024);
    assert.deepEqual(result.value, { ok: true });
  } finally {
    Buffer.allocUnsafe = originalAllocUnsafe;
  }
  assert.equal(allocations[0], 4 * 1024);
  assert.ok(!allocations.includes(64 * 1024), 'tiny chunked response must not allocate the full ceiling');
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

{
  const minerSource = await readFile(join(here, 'mine.mjs'), 'utf8');
  const packageSource = await readFile(join(here, 'package-miner.mjs'), 'utf8');
  const parserSource = await readFile(join(here, 'miner-rpc-response.mjs'), 'utf8');
  assert.match(minerSource, /readBoundedJsonResponse/);
  assert.doesNotMatch(minerSource, /Buffer\.concat\(chunks/);
  assert.match(packageSource, /miner-rpc-response\.mjs/);
  assert.match(parserSource, /Math\.min\(maxBytes, DEFAULT_UNDECLARED_INITIAL_BYTES\)/);
  assert.match(parserSource, /Math\.min\(maxBytes, Math\.max\(required, Math\.max\(1, capacity\) \* 2\)\)/);
  assert.doesNotMatch(parserSource, /declaredBytes \?\? maxBytes/);
}

console.log('miner RPC response parser regressions passed');
