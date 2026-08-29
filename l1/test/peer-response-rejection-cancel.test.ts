import assert from "node:assert/strict";
import test from "node:test";

import { PeerClient as BasePeerClient } from "../src/node-base.js";
import { PeerClient as HttpConsensusPeerClient } from "../src/node.js";
import type { Block } from "../src/types.js";

const dummyBlock = {} as Block;
const expectedChain = { chainId: "zyron-test", genesisHash: "11".repeat(32) };

function streamingResponse(
  status: number,
  headers: Record<string, string>,
  onCancel: () => void | Promise<void>
): Response {
  return new Response(new ReadableStream<Uint8Array>({
    cancel() {
      return onCancel();
    },
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    }
  }), { status, headers });
}

test("base peer GET cancels non-success response body before rejecting", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => streamingResponse(
    503,
    { "content-type": "application/json", "x-zyron-rpc-version": "1" },
    () => { cancelled = true; }
  );
  try {
    const client = new BasePeerClient(["https://peer.example"]);
    await assert.rejects(
      client.fetchPeerRecords("https://peer.example", expectedChain),
      /Peer returned HTTP 503/
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("base peer POST cancels non-success response body and contributes no attestation", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => streamingResponse(
    429,
    { "content-type": "application/json", "x-zyron-rpc-version": "1" },
    () => { cancelled = true; }
  );
  try {
    const client = new BasePeerClient(["https://peer.example"]);
    assert.deepEqual(await client.requestAttestations(dummyBlock), []);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("base peer RPC-version rejection cancels body and remains fail-closed", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => streamingResponse(
    200,
    { "content-type": "application/json" },
    () => { cancelled = true; }
  );
  try {
    const client = new BasePeerClient(["https://peer.example"]);
    await assert.rejects(
      client.fetchPeerRecords("https://peer.example", expectedChain),
      /missing RPC API version/
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP consensus cancels non-success response body and contributes no vote", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => streamingResponse(
    503,
    { "content-type": "application/json", "x-zyron-rpc-version": "1" },
    () => { cancelled = true; }
  );
  try {
    const client = new HttpConsensusPeerClient(["https://peer.example"]);
    assert.deepEqual(await client.requestAttestations(dummyBlock), []);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("response cancellation failure never replaces the original HTTP rejection", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamingResponse(
    500,
    { "content-type": "application/json", "x-zyron-rpc-version": "1" },
    () => { throw new Error("synthetic cancel failure"); }
  );
  try {
    const client = new BasePeerClient(["https://peer.example"]);
    await assert.rejects(
      client.fetchPeerRecords("https://peer.example", expectedChain),
      /Peer returned HTTP 500/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pending response cancellation cannot stall a fail-closed HTTP rejection", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const neverSettles = new Promise<void>(() => {});
  globalThis.fetch = async () => streamingResponse(
    503,
    { "content-type": "application/json", "x-zyron-rpc-version": "1" },
    () => {
      cancelled = true;
      return neverSettles;
    }
  );
  try {
    const client = new BasePeerClient(["https://peer.example"]);
    const outcome = await Promise.race<Error | "timeout">([
      client.fetchPeerRecords("https://peer.example", expectedChain).then(
        () => new Error("peer rejection unexpectedly resolved"),
        (error: unknown) => error instanceof Error ? error : new Error(String(error))
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250))
    ]);
    assert.notEqual(outcome, "timeout", "peer rejection waited for response-body cancellation settlement");
    assert.match((outcome as Error).message, /Peer returned HTTP 503/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
