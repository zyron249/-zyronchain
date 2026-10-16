// P1-02 (RPC limits review): boundary tests for the node RPC limits listed in
// docs/RPC_LIMITS_REVIEW.md that had no exact-boundary test yet.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createRpcServer, MAX_SYNC_BLOCKS, NodeService } from "../src/node-base.js";
import { ChainStore } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

const MAX_RPC_BODY_BYTES = 2_500_000; // node-base.ts MAX_BODY_BYTES

function genesis(): GenesisConfig {
  const keys = ["a1", "a2", "a3"].map((byte) => publicKeyFromPrivate(byte.padStart(64, "0")));
  return {
    chainId: "zyron-rpc-limits-1",
    timestampMs: 1_700_000_000_000,
    validators: keys.slice(0, 2).map((publicKey) => ({ address: addressFromPublicKey(publicKey), publicKey })),
    activityOracles: [keys[2]!],
    activityPool: addressFromPublicKey(keys[2]!),
    allocations: [{ address: addressFromPublicKey(keys[2]!), amountAtoms: 1_000_000 }]
  };
}

async function withServer(options: Parameters<typeof createRpcServer>[1], run: (port: number) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zyron-rpc-boundary-"));
  const store = await ChainStore.open(genesis(), directory);
  const server = createRpcServer(new NodeService(store), options);
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => done()); });
    await run((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}

function post(port: number, path: string, body: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// A JSON object of exactly `bytes` bytes.
function jsonOfSize(bytes: number): Buffer {
  const overhead = Buffer.byteLength('{"pad":""}');
  return Buffer.from(`{"pad":"${"a".repeat(bytes - overhead)}"}`);
}

test("POST /tx body cap: exactly MAX_BODY_BYTES is read and parsed, one byte more is refused", async () => {
  await withServer({}, async (port) => {
    const exact = jsonOfSize(MAX_RPC_BODY_BYTES);
    assert.equal(exact.length, MAX_RPC_BODY_BYTES);
    const atCap = await post(port, "/tx", exact);
    assert.equal(atCap.status, 400);
    assert.doesNotMatch(atCap.body, /too large|Content-Length/);
    const over = await post(port, "/tx", jsonOfSize(MAX_RPC_BODY_BYTES + 1));
    assert.equal(over.status, 400);
    assert.match(over.body, /Request body too large/);
  });
});

test("POST /tx without a declared length is capped while streaming", async () => {
  await withServer({}, async (port) => {
    const over = await post(port, "/tx", jsonOfSize(MAX_RPC_BODY_BYTES + 1), { "transfer-encoding": "chunked" });
    assert.equal(over.status, 400);
    assert.match(over.body, /Request body too large/);
  });
});

test("POST /tx requires application/json and a non-empty body", async () => {
  await withServer({}, async (port) => {
    const wrongType = await post(port, "/tx", Buffer.from("{}"), { "content-type": "text/plain" });
    assert.equal(wrongType.status, 400);
    assert.match(wrongType.body, /Content-Type must be application\/json/);
    const empty = await post(port, "/tx", Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.match(empty.body, /Request body is empty/);
  });
});

test("GET /blocks limit: MAX_SYNC_BLOCKS accepted, MAX_SYNC_BLOCKS + 1 and 0 refused", async () => {
  await withServer({}, async (port) => {
    const base = `http://127.0.0.1:${port}`;
    const ok = await fetch(`${base}/blocks?from=1&limit=${MAX_SYNC_BLOCKS}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { blocks: [] });
    for (const limit of [MAX_SYNC_BLOCKS + 1, 0]) {
      const refused = await fetch(`${base}/blocks?from=1&limit=${limit}`);
      assert.equal(refused.status, 400);
      assert.match(JSON.stringify(await refused.json()), /Invalid block limit/);
    }
    const badFrom = await fetch(`${base}/blocks?from=0`);
    assert.equal(badFrom.status, 400);
  });
});

test("per-client window: exactly requestsPerWindow requests pass, the next one gets 429 with retry-after", async () => {
  await withServer({ requestsPerWindow: 5, windowMs: 60_000 }, async (port) => {
    const base = `http://127.0.0.1:${port}`;
    for (let index = 1; index <= 5; index += 1) {
      const response = await fetch(`${base}/status`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-ratelimit-remaining"), String(5 - index));
    }
    const limited = await fetch(`${base}/status`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    // POST /tx is counted by the same per-client limiter before the body is read.
    const tx = await post(port, "/tx", Buffer.from("{}"));
    assert.equal(tx.status, 429);
  });
});

test("consensus write routes refuse unauthenticated callers before reading the body", async () => {
  await withServer({ peerAuthToken: "p1-02-boundary-token-0123456789abcdef" }, async (port) => {
    for (const path of ["/proposal/attest", "/round/skip", "/block", "/v6/prepare", "/v6/commit", "/v6/timeout", "/v6/block"]) {
      const response = await post(port, path, jsonOfSize(MAX_RPC_BODY_BYTES + 1));
      assert.equal(response.status, 401, path);
    }
  });
});
