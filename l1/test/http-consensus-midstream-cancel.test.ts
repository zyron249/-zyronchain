import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_HTTP_ATTESTATION_RESPONSE_BYTES,
  PeerClient,
  RPC_API_VERSION
} from "../src/node.js";
import type { Block } from "../src/types.js";

test("pending mid-stream cancellation cannot stall HTTP-consensus oversize rejection", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const neverSettles = new Promise<void>(() => {});
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_HTTP_ATTESTATION_RESPONSE_BYTES + 1));
    },
    cancel() {
      cancelled = true;
      return neverSettles;
    }
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-zyron-rpc-version": String(RPC_API_VERSION)
    }
  });

  try {
    const client = new PeerClient(["https://peer.example"]);
    const outcome = await Promise.race<readonly unknown[] | "timeout">([
      client.requestAttestations({} as Block),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250))
    ]);

    assert.notEqual(outcome, "timeout", "HTTP-consensus rejection waited for reader cancellation settlement");
    assert.deepEqual(outcome, []);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
