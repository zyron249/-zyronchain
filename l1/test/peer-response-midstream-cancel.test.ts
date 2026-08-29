import assert from "node:assert/strict";
import test from "node:test";

import { PeerClient, RPC_API_VERSION } from "../src/node-base.js";

const expectedChain = { chainId: "zyron-test", genesisHash: "11".repeat(32) };

function pendingCancelResponse(chunkBytes: number, onCancel: () => void): Response {
  const neverSettles = new Promise<void>(() => {});
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      onCancel();
      return neverSettles;
    }
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-zyron-rpc-version": String(RPC_API_VERSION)
    }
  });
}

test("pending mid-stream cancellation cannot stall base peer oversize rejection", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => pendingCancelResponse(256_001, () => { cancelled = true; });

  try {
    const client = new PeerClient(["https://peer.example"]);
    const outcome = await Promise.race<Error | "timeout">([
      client.fetchPeerRecords("https://peer.example", expectedChain).then(
        () => new Error("oversize peer response unexpectedly resolved"),
        (error: unknown) => error instanceof Error ? error : new Error(String(error))
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250))
    ]);

    assert.notEqual(outcome, "timeout", "base peer oversize rejection waited for reader cancellation settlement");
    assert.match((outcome as Error).message, /Peer response too large/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
