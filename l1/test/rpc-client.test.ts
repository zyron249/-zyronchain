import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRpcApiVersion,
  MAX_RPC_CLIENT_JSON_NESTING_DEPTH,
  MAX_RPC_CLIENT_JSON_STRUCTURAL_TOKENS,
  readBoundedJson,
  readBoundedResponseText,
  transactionVersionForProtocolVersion
} from "../src/rpc-client.js";

test("protocol versions map to the canonical transaction signing format", () => {
  assert.equal(transactionVersionForProtocolVersion(1), 1);
  assert.equal(transactionVersionForProtocolVersion(2), 1);
  assert.equal(transactionVersionForProtocolVersion(3), 2);
  assert.equal(transactionVersionForProtocolVersion(5), 2);
  for (const unsupported of [0, 4, 6, 65_535, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => transactionVersionForProtocolVersion(unsupported), /invalid protocol status|unsupported next protocol version/);
  }
});

test("bounded RPC text rejects oversized declared and streamed bodies before unbounded buffering", async () => {
  await assert.rejects(
    readBoundedResponseText(new Response("small", { headers: { "content-length": "1000" } }), 64),
    /too large/
  );

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(40));
      controller.enqueue(new Uint8Array(40));
      controller.close();
    }
  });
  await assert.rejects(readBoundedResponseText(new Response(body), 64), /too large/);
});

test("bounded RPC text sizes unknown-length buffers to observed payloads", async () => {
  const allocations: number[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ok"));
      controller.close();
    }
  });
  assert.equal(
    await readBoundedResponseText(new Response(body), 64 * 1024, "RPC response", {
      onAllocate(bytes) { allocations.push(bytes); }
    }),
    "ok"
  );
  assert.deepEqual(allocations, [4 * 1024]);
});

test("bounded RPC text grows unknown-length buffers only as observed bytes require", async () => {
  const allocations: number[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3_000).fill(0x61));
      controller.enqueue(new Uint8Array(2_000).fill(0x62));
      controller.close();
    }
  });
  const text = await readBoundedResponseText(new Response(body), 64 * 1024, "RPC response", {
    onAllocate(bytes) { allocations.push(bytes); }
  });
  assert.equal(Buffer.byteLength(text), 5_000);
  assert.deepEqual(allocations, [4 * 1024, 8 * 1024]);
});

test("bounded RPC text enforces declared body length exactly", async () => {
  await assert.rejects(
    readBoundedResponseText(new Response("short", { headers: { "content-length": "6" } }), 64),
    /mismatched Content-Length/
  );
});

test("bounded RPC JSON validates payload size, syntax and API version", async () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { "x-zyron-rpc-version": "1" }
  });
  assertRpcApiVersion(response, 1);
  assert.deepEqual(await readBoundedJson(response, 64), { ok: true });

  assert.throws(
    () => assertRpcApiVersion(new Response(""), 1),
    /did not advertise an API version/
  );
  assert.throws(
    () => assertRpcApiVersion(new Response("", { headers: { "x-zyron-rpc-version": "2" } }), 1),
    /unsupported API version/
  );
  await assert.rejects(readBoundedJson(new Response("not-json"), 64), /not valid JSON/);
});

test("bounded RPC JSON accepts the exact nesting limit and rejects one level over", async () => {
  const exact = `${"[".repeat(MAX_RPC_CLIENT_JSON_NESTING_DEPTH)}0${"]".repeat(MAX_RPC_CLIENT_JSON_NESTING_DEPTH)}`;
  await readBoundedJson(new Response(exact), Buffer.byteLength(exact));

  const over = `[${exact}]`;
  await assert.rejects(
    readBoundedJson(new Response(over), Buffer.byteLength(over)),
    /JSON complexity exceeded/
  );
});

test("bounded RPC JSON rejects structural cardinality over the exact token limit", async () => {
  // A flat array with N elements contains N+1 structural tokens: '[' + ']'
  // plus N-1 commas. Therefore N=MAX-1 is exact-bound and N=MAX is over.
  const exact = `[${new Array(MAX_RPC_CLIENT_JSON_STRUCTURAL_TOKENS - 1).fill("0").join(",")}]`;
  await readBoundedJson(new Response(exact), Buffer.byteLength(exact));

  const over = `[${new Array(MAX_RPC_CLIENT_JSON_STRUCTURAL_TOKENS).fill("0").join(",")}]`;
  await assert.rejects(
    readBoundedJson(new Response(over), Buffer.byteLength(over)),
    /JSON complexity exceeded/
  );
});

test("bounded RPC JSON ignores structural punctuation and escaped quotes inside strings", async () => {
  const payload = JSON.stringify({ text: "{[,:]} \\\" still-string", ok: true });
  assert.deepEqual(
    await readBoundedJson(new Response(payload), Buffer.byteLength(payload)),
    { text: "{[,:]} \\\" still-string", ok: true }
  );
});