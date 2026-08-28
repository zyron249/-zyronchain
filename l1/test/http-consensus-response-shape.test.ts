import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  MAX_HTTP_ATTESTATION_RESPONSE_BYTES,
  MAX_HTTP_CONSENSUS_OUTBOUND_CONCURRENCY,
  MAX_HTTP_ROUND_SKIP_RESPONSE_BYTES,
  PeerClient,
  collectHttpConsensusPeers,
  validateHttpPeerAttestationShape,
  validateHttpPeerRoundSkipVoteShape
} from "../src/node.js";
import type { Block } from "../src/types.js";

const publicKey = publicKeyFromPrivate("11".repeat(32));
const validator = addressFromPublicKey(publicKey);
const signature = "ab".repeat(64);

function attestation() {
  return { validator, publicKey, signature };
}

function skipVote() {
  return {
    validator,
    publicKey,
    chainId: "zyron-test-chain",
    height: 12,
    round: 3,
    previousHash: "cd".repeat(32),
    signature
  };
}

function jsonHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-zyron-rpc-version": "1",
    ...extra
  });
}

const dummyBlock = {} as Block;

test("HTTP peer attestation shape accepts only canonical fixed fields", () => {
  const value = attestation();
  assert.deepEqual(validateHttpPeerAttestationShape(value), value);
  assert.throws(
    () => validateHttpPeerAttestationShape({ ...value, nested: { retained: "x".repeat(1024) } }),
    /fields|attestation/i
  );
  assert.throws(
    () => validateHttpPeerAttestationShape({ ...value, publicKey: "00".repeat(63) }),
    /public key|hex/i
  );
  assert.throws(
    () => validateHttpPeerAttestationShape({ ...value, validator: `ZYN${"0".repeat(40)}` }),
    /validator/i
  );
});

test("HTTP peer round-skip shape rejects retained nested and malformed primitives", () => {
  const value = skipVote();
  assert.deepEqual(validateHttpPeerRoundSkipVoteShape(value), value);
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, extra: { retained: [1, 2, 3] } }),
    /fields|round skip/i
  );
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, chainId: "x".repeat(129) }),
    /round skip/i
  );
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, height: Number.MAX_SAFE_INTEGER + 1 }),
    /round skip/i
  );
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, previousHash: "ef".repeat(31) }),
    /previous hash|hex/i
  );
  assert.throws(
    () => validateHttpPeerRoundSkipVoteShape({ ...value, validator: `ZYN${"f".repeat(40)}` }),
    /validator/i
  );
});

test("HTTP consensus response ceilings are fixed-shape sized", () => {
  assert.equal(MAX_HTTP_ATTESTATION_RESPONSE_BYTES, 8_192);
  assert.equal(MAX_HTTP_ROUND_SKIP_RESPONSE_BYTES, 16_384);
  const attestationBody = Buffer.byteLength(JSON.stringify({ attestation: attestation() }), "utf8");
  const skipBody = Buffer.byteLength(JSON.stringify({ vote: skipVote() }), "utf8");
  assert.ok(attestationBody < MAX_HTTP_ATTESTATION_RESPONSE_BYTES / 4);
  assert.ok(skipBody < MAX_HTTP_ROUND_SKIP_RESPONSE_BYTES / 4);
});

test("HTTP attestation rejects oversized declared length before parsing", async () => {
  const originalFetch = globalThis.fetch;
  let bodyCancelled = false;
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      }
    });
    return new Response(stream, {
      status: 200,
      headers: jsonHeaders({ "content-length": String(MAX_HTTP_ATTESTATION_RESPONSE_BYTES + 1) })
    });
  };
  try {
    const client = new PeerClient(["https://peer.example"]);
    assert.deepEqual(await client.requestAttestations(dummyBlock), []);
    assert.equal(bodyCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP round-skip rejects streamed bytes above its fixed route ceiling", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_HTTP_ROUND_SKIP_RESPONSE_BYTES + 1));
      }
    });
    return new Response(stream, { status: 200, headers: jsonHeaders() });
  };
  try {
    const client = new PeerClient(["https://peer.example"]);
    assert.deepEqual(await client.requestRoundSkips(12, 3), []);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP attestation canonical response remains accepted under tightened ceiling", async () => {
  const originalFetch = globalThis.fetch;
  const value = attestation();
  const body = JSON.stringify({ attestation: value });
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: jsonHeaders({ "content-length": String(Buffer.byteLength(body, "utf8")) })
  });
  try {
    const client = new PeerClient(["https://peer.example"]);
    assert.deepEqual(await client.requestAttestations(dummyBlock), [value]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP consensus collection bounds aggregate concurrency", async () => {
  const peers = Array.from({ length: 32 }, (_, index) => `peer-${index}`);
  let active = 0;
  let maxActive = 0;
  let started = 0;
  let releaseFirstWave!: () => void;
  const firstWaveGate = new Promise<void>((resolve) => {
    releaseFirstWave = resolve;
  });
  const pending = collectHttpConsensusPeers(peers, async (peer) => {
    active += 1;
    started += 1;
    maxActive = Math.max(maxActive, active);
    if (started <= MAX_HTTP_CONSENSUS_OUTBOUND_CONCURRENCY) {
      await firstWaveGate;
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    active -= 1;
    return peer;
  }, 1_000);
  while (active < MAX_HTTP_CONSENSUS_OUTBOUND_CONCURRENCY) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(maxActive, MAX_HTTP_CONSENSUS_OUTBOUND_CONCURRENCY);
  releaseFirstWave();
  const result = await pending;
  assert.equal(result.length, peers.length);
  assert.ok(maxActive <= MAX_HTTP_CONSENSUS_OUTBOUND_CONCURRENCY);
});

test("HTTP consensus collection uses one shared wall-clock deadline", async () => {
  const peers = Array.from({ length: 64 }, (_, index) => `peer-${index}`);
  let started = 0;
  const startedAt = Date.now();
  const result = await collectHttpConsensusPeers(peers, async (_peer, signal) => {
    started += 1;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return "unreachable";
  }, 40, 4);
  const elapsed = Date.now() - startedAt;
  assert.deepEqual(result, []);
  assert.ok(started <= 4, `started ${started} requests after deadline`);
  assert.ok(elapsed < 250, `shared deadline took ${elapsed}ms`);
});
