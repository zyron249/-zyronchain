import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import test from "node:test";

import { assertSafeRpcBinding, createRpcServer, NodeService, RPC_API_VERSION } from "../src/node-base.js";

/**
 * ZC-CRY-20260930-001 (closes ZC-AUD-20260928-008).
 * Consensus routes must fail closed when no consensus authentication is bound:
 * only a direct loopback caller on a server without a trusted proxy may reach
 * them unauthenticated, unless the embedder opts in explicitly.
 */

const PEER_TOKEN = "t".repeat(48);

function stubService(): { service: NodeService; reached: () => number } {
  let count = 0;
  const service = {
    prepareProposal: async () => {
      count += 1;
      throw new Error("stub prepare reached");
    },
    submitTransaction: () => {
      count += 1;
      throw new Error("stub tx reached");
    }
  } as unknown as NodeService;
  return { service, reached: () => count };
}

async function listen(server: ReturnType<typeof createRpcServer>, host = "127.0.0.1"): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function post(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION), "content-type": "application/json", ...headers },
    body: "{}"
  });
}

test("CRYPTO-REVIEW: proxied consensus request without bound auth is rejected before the handler", async () => {
  const { service, reached } = stubService();
  const running = await listen(createRpcServer(service, { trustedProxyAddresses: ["127.0.0.1"] }));
  try {
    const response = await post(`http://127.0.0.1:${running.port}/proposal/prepare`, { "x-forwarded-proto": "https" });
    assert.equal(response.status, 401);
    assert.equal(reached(), 0, "consensus handler must not run for unauthenticated proxied traffic");
    const tx = await post(`http://127.0.0.1:${running.port}/tx`, { "x-forwarded-proto": "https" });
    assert.equal(tx.status, 400, "public routes stay reachable through the proxy");
    assert.equal(reached(), 1);
  } finally {
    await running.close();
  }
});

test("CRYPTO-REVIEW: direct loopback consensus without auth stays available for local devnets", async () => {
  const { service, reached } = stubService();
  const running = await listen(createRpcServer(service));
  try {
    const response = await post(`http://127.0.0.1:${running.port}/proposal/prepare`);
    assert.equal(response.status, 400);
    assert.equal(reached(), 1);
  } finally {
    await running.close();
  }
});

test("CRYPTO-REVIEW: explicit allowUnauthenticatedConsensus opt-in restores legacy behavior", async () => {
  const { service, reached } = stubService();
  const running = await listen(createRpcServer(service, {
    trustedProxyAddresses: ["127.0.0.1"],
    allowUnauthenticatedConsensus: true
  }));
  try {
    const response = await post(`http://127.0.0.1:${running.port}/proposal/prepare`, { "x-forwarded-proto": "https" });
    assert.equal(response.status, 400);
    assert.equal(reached(), 1);
  } finally {
    await running.close();
  }
});

test("CRYPTO-REVIEW: bound bearer auth still authorizes proxied consensus and rejects a wrong token", async () => {
  const { service, reached } = stubService();
  const running = await listen(createRpcServer(service, { trustedProxyAddresses: ["127.0.0.1"], peerAuthToken: PEER_TOKEN }));
  try {
    const bad = await post(`http://127.0.0.1:${running.port}/proposal/prepare`, {
      "x-forwarded-proto": "https",
      authorization: `Bearer ${"x".repeat(48)}`
    });
    assert.equal(bad.status, 401);
    assert.equal(reached(), 0);
    const good = await post(`http://127.0.0.1:${running.port}/proposal/prepare`, {
      "x-forwarded-proto": "https",
      authorization: `Bearer ${PEER_TOKEN}`
    });
    assert.equal(good.status, 400);
    assert.equal(reached(), 1);
  } finally {
    await running.close();
  }
});

const externalIpv4 = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;

test("CRYPTO-REVIEW: direct non-loopback consensus without auth is rejected", { skip: externalIpv4 ? false : "no non-loopback IPv4 interface" }, async () => {
  const { service, reached } = stubService();
  const running = await listen(createRpcServer(service), "0.0.0.0");
  try {
    const response = await post(`http://${externalIpv4}:${running.port}/proposal/prepare`);
    assert.equal(response.status, 401);
    assert.equal(reached(), 0);
  } finally {
    await running.close();
  }
});

test("CRYPTO-REVIEW: CLI binding rejects loopback-behind-proxy without consensus auth", () => {
  assert.throws(() => assertSafeRpcBinding("127.0.0.1", false, true), /trusted proxy requires consensus peer authentication/);
  assert.doesNotThrow(() => assertSafeRpcBinding("127.0.0.1", true, true));
  assert.doesNotThrow(() => assertSafeRpcBinding("127.0.0.1", false, false));
});
