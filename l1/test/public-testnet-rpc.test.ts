import assert from "node:assert/strict";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRpcServer,
  DEFAULT_RPC_HEADERS_TIMEOUT_MS,
  DEFAULT_RPC_MAX_CONNECTIONS,
  DEFAULT_RPC_MAX_INFLIGHT_REQUESTS,
  DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  DEFAULT_RPC_REQUESTS_PER_WINDOW,
  MAX_BODY_BYTES,
  type NodeService
} from "../src/node-base.js";
import {
  admitPublicTestnetRpc,
  classifyRpcRoute,
  parsePublicTestnetRpc,
  PUBLIC_RPC_LIMITS,
  PUBLIC_RPC_PLACEHOLDER
} from "../src/public-testnet-rpc.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const checkedInPath = join(here, "../../config/public-testnet-rpc.json");
const sourcePath = join(here, "../../src/public-testnet-rpc.ts");

test("checked-in public RPC proposal is disabled placeholders and does not bind", async () => {
  const previous = process.env.ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_A;
  process.env.ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_A = "https://rpc.example.com";
  try {
    const config = parsePublicTestnetRpc(JSON.parse(await readFile(checkedInPath, "utf8")));
    assert.equal(config.live, false);
    assert.equal(config.publicRole.enabled, false);
    assert.deepEqual(config.publicRole.origins, [PUBLIC_RPC_PLACEHOLDER, PUBLIC_RPC_PLACEHOLDER]);
    assert.equal(config.validatorRole.servesConsensusRoutes, true);
    assert.deepEqual(config.publicLimits, PUBLIC_RPC_LIMITS);
    const admission = admitPublicTestnetRpc(config, true);
    assert.deepEqual(admission.bindTargets, []);
    assert.deepEqual(admission.reasons, ["public-rpc-unfilled", "public-rpc-not-bindable"]);
    assert.equal(JSON.stringify(config).includes("https://"), false);
  } finally {
    if (previous === undefined) delete process.env.ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_A;
    else process.env.ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_A = previous;
  }
});

test("public RPC parser does not consult process environment and rejects live origins", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.equal(source.includes("process.env"), false);
  const config = parsePublicTestnetRpc(JSON.parse(await readFile(checkedInPath, "utf8")));
  assert.throws(() => parsePublicTestnetRpc({ ...config, live: true }), /cannot be marked live/);
  assert.throws(
    () => parsePublicTestnetRpc({
      ...config,
      publicRole: { ...config.publicRole, origins: ["https://rpc-a.bootstrap-fixture.net", PUBLIC_RPC_PLACEHOLDER] }
    }),
    /PLACEHOLDER/
  );
  assert.throws(
    () => parsePublicTestnetRpc({
      ...config,
      publicLimits: { ...config.publicLimits, maxConnections: DEFAULT_RPC_MAX_CONNECTIONS }
    }),
    /maxConnections/
  );
});

test("public RPC limits stay stricter than the combined validator RPC defaults", () => {
  assert.ok(PUBLIC_RPC_LIMITS.requestsPerWindow < DEFAULT_RPC_REQUESTS_PER_WINDOW);
  assert.ok(PUBLIC_RPC_LIMITS.maxRequestBytes < MAX_BODY_BYTES);
  assert.ok(PUBLIC_RPC_LIMITS.requestTimeoutMs < DEFAULT_RPC_REQUEST_TIMEOUT_MS);
  assert.ok(PUBLIC_RPC_LIMITS.headersTimeoutMs < DEFAULT_RPC_HEADERS_TIMEOUT_MS);
  assert.ok(PUBLIC_RPC_LIMITS.maxConnections < DEFAULT_RPC_MAX_CONNECTIONS);
  assert.ok(PUBLIC_RPC_LIMITS.maxInflightRequests < DEFAULT_RPC_MAX_INFLIGHT_REQUESTS);
});

test("public RPC role serves reads and transaction submission, not consensus or operator routes", () => {
  assert.equal(classifyRpcRoute("GET", "/status"), "public");
  assert.equal(classifyRpcRoute("GET", "/balance/ZYN" + "ab".repeat(20)), "public");
  assert.equal(classifyRpcRoute("POST", "/tx"), "public");
  assert.equal(classifyRpcRoute("POST", "/proposal/attest"), "consensus");
  assert.equal(classifyRpcRoute("POST", "/round/skip"), "consensus");
  assert.equal(classifyRpcRoute("POST", "/round/lock"), "consensus");
  assert.equal(classifyRpcRoute("POST", "/block"), "consensus");
  assert.equal(classifyRpcRoute("GET", "/blocks"), "operator");
  assert.equal(classifyRpcRoute("GET", "/metrics"), "operator");
  assert.equal(classifyRpcRoute("GET", "/peers"), "operator");
});

test("public RPC server refuses consensus routes and cannot raise connection ceilings", async () => {
  assert.throws(
    () => createRpcServer({} as NodeService, { rpcRole: "public", maxConnections: DEFAULT_RPC_MAX_CONNECTIONS }),
    /cannot raise the connection ceiling/
  );
  const server = createRpcServer({} as NodeService, { rpcRole: "public" });
  assert.equal(server.maxConnections, PUBLIC_RPC_LIMITS.maxConnections);
  assert.equal(server.requestTimeout, PUBLIC_RPC_LIMITS.requestTimeoutMs);
  assert.equal(server.headersTimeout, PUBLIC_RPC_LIMITS.headersTimeoutMs);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Public RPC test server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const info = await fetch(`${base}/rpc-info`);
    assert.equal(info.status, 200);
    const attest = await fetch(`${base}/proposal/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(attest.status, 403);
    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 403);
    const oversized = await post(base, "/tx", "x".repeat(PUBLIC_RPC_LIMITS.maxRequestBytes + 1));
    assert.equal(oversized.status, 400);
    assert.match(oversized.body, /too large/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function post(base: string, path: string, body: string): Promise<{ status: number; body: string }> {
  const target = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.once("error", reject);
    req.end(body);
  });
}
