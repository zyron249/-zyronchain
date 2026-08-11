import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRpcApiVersion,
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

test("bounded RPC JSON validates payload size, syntax and API version", async () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { "x-zyron-rpc-version": "1" }
  });
  assertRpcApiVersion(response, 1);
  assert.deepEqual(await readBoundedJson(response, 64), { ok: true });

  assert.throws(
    () => assertRpcApiVersion(new Response("", { headers: { "x-zyron-rpc-version": "2" } }), 1),
    /unsupported API version/
  );
  await assert.rejects(readBoundedJson(new Response("not-json"), 64), /not valid JSON/);
});
