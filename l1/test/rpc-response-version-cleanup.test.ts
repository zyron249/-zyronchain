import assert from "node:assert/strict";
import test from "node:test";

import { assertRpcResponseVersion } from "../src/rpc-response-version.js";

function rejectedResponse(version?: string, cancelError?: Error): { response: Response; cancelled: () => boolean } {
  let wasCancelled = false;
  const body = {
    cancel() {
      wasCancelled = true;
      if (cancelError) throw cancelError;
      return Promise.resolve();
    }
  };
  const headers = {
    get(name: string) {
      if (name.toLowerCase() !== "x-zyron-rpc-version") return null;
      return version ?? null;
    }
  };
  return {
    response: { headers, body } as unknown as Response,
    cancelled: () => wasCancelled
  };
}

test("RPC version rejection cancels an unconsumed response body", () => {
  const missing = rejectedResponse();
  assert.throws(
    () => assertRpcResponseVersion(missing.response, 1, "miner RPC"),
    /did not advertise an API version/
  );
  assert.equal(missing.cancelled(), true);

  const incompatible = rejectedResponse("2");
  assert.throws(
    () => assertRpcResponseVersion(incompatible.response, 1, "miner RPC"),
    /unsupported API version 2/
  );
  assert.equal(incompatible.cancelled(), true);
});

test("RPC version cleanup failure preserves the original rejection", () => {
  const rejected = rejectedResponse("9", new Error("cleanup failed"));
  assert.throws(
    () => assertRpcResponseVersion(rejected.response, 1, "miner RPC"),
    /unsupported API version 9/
  );
  assert.equal(rejected.cancelled(), true);
});
