import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "../scripts/miner-rpc-response.mjs";
const { readBoundedJsonResponse } = await import(modulePath) as {
  readBoundedJsonResponse: (response: Response, maxBytes: number) => Promise<unknown>;
};

function responseWithLength(value: string, cancelError?: Error): { response: Response; cancelled: () => boolean } {
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      wasCancelled = true;
      if (cancelError) throw cancelError;
    }
  });
  return {
    response: new Response(stream, { headers: { "content-length": value } }),
    cancelled: () => wasCancelled
  };
}

test("miner RPC invalid Content-Length cancels unconsumed body", async () => {
  const rejected = responseWithLength("not-a-number");
  await assert.rejects(readBoundedJsonResponse(rejected.response, 64 * 1024), /invalid Content-Length/);
  assert.equal(rejected.cancelled(), true);
});

test("miner RPC oversized declared response cancels unconsumed body", async () => {
  const rejected = responseWithLength(String(64 * 1024 + 1));
  await assert.rejects(readBoundedJsonResponse(rejected.response, 64 * 1024), /exceeds 64 KiB limit/);
  assert.equal(rejected.cancelled(), true);
});

test("miner RPC cleanup failure preserves early Content-Length rejection", async () => {
  const rejected = responseWithLength("invalid", new Error("cleanup failed"));
  await assert.rejects(readBoundedJsonResponse(rejected.response, 64 * 1024), /invalid Content-Length/);
  assert.equal(rejected.cancelled(), true);
});
