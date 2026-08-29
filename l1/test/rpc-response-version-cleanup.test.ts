import assert from "node:assert/strict";
import test from "node:test";

import { assertRpcResponseVersionWithBodyCleanup } from "../src/rpc-response-version.js";

function rejectedResponse(version?: string, cancelError?: Error): { response: Response; cancelled: () => boolean } {
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      wasCancelled = true;
      if (cancelError) throw cancelError;
    }
  });
  const headers = new Headers();
  if (version !== undefined) headers.set("x-zyron-rpc-version", version);
  return {
    response: new Response(body, { headers }),
    cancelled: () => wasCancelled
  };
}

test("RPC version rejection cancels an unconsumed response body", async () => {
  const missing = rejectedResponse();
  await assert.rejects(
    assertRpcResponseVersionWithBodyCleanup(missing.response, 1, "miner RPC"),
    /did not advertise an API version/
  );
  assert.equal(missing.cancelled(), true);

  const incompatible = rejectedResponse("2");
  await assert.rejects(
    assertRpcResponseVersionWithBodyCleanup(incompatible.response, 1, "miner RPC"),
    /unsupported API version 2/
  );
  assert.equal(incompatible.cancelled(), true);
});

test("RPC version cleanup failure preserves the original rejection", async () => {
  const rejected = rejectedResponse("9", new Error("cleanup failed"));
  await assert.rejects(
    assertRpcResponseVersionWithBodyCleanup(rejected.response, 1, "miner RPC"),
    /unsupported API version 9/
  );
  assert.equal(rejected.cancelled(), true);
});
