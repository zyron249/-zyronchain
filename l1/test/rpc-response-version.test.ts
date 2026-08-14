import assert from "node:assert/strict";
import test from "node:test";

import { assertRpcResponseVersion } from "../src/rpc-response-version.js";

function response(version?: string): Pick<Response, "headers"> {
  const headers = new Headers();
  if (version !== undefined) headers.set("x-zyron-rpc-version", version);
  return { headers };
}

test("RPC response version accepts the exact advertised version", () => {
  assert.doesNotThrow(() => assertRpcResponseVersion(response("1"), 1));
});

test("RPC response version fails closed when the header is missing", () => {
  assert.throws(
    () => assertRpcResponseVersion(response(), 1),
    /RPC server did not advertise an API version/
  );
});

test("RPC response version rejects mismatched advertisements", () => {
  assert.throws(
    () => assertRpcResponseVersion(response("2"), 1),
    /RPC server uses unsupported API version 2/
  );
});

test("RPC response version validates the expected version", () => {
  assert.throws(
    () => assertRpcResponseVersion(response("1"), 0),
    /Invalid expected RPC API version/
  );
});
