import assert from "node:assert/strict";
import test from "node:test";

// The canonical suite executes compiled tests from l1/dist/test while the miner
// response helper remains an .mjs runtime script under l1/scripts. Resolve the
// helper from the compiled test location without requiring a copied dist/scripts
// tree that the production package does not create.
const moduleUrl = new URL("../../scripts/miner-rpc-response.mjs", import.meta.url);
const { readBoundedJsonResponse } = await import(moduleUrl.href) as {
  readBoundedJsonResponse: (response: Response, maxBytes: number) => Promise<unknown>;
};

function responseWithLength(value: string, cancelError?: Error): { response: Response; cancelled: () => boolean } {
  let wasCancelled = false;
  const body = {
    cancel() {
      wasCancelled = true;
      return cancelError ? Promise.reject(cancelError) : Promise.resolve();
    }
  };
  const headers = {
    get(name: string) {
      return name.toLowerCase() === "content-length" ? value : null;
    }
  };
  return {
    response: { headers, body } as unknown as Response,
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
