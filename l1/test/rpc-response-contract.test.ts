import assert from "node:assert/strict";
import { createServer as createHttpServer, request } from "node:http";
import test from "node:test";

import { createRpcServer, NodeService, PeerClient, RPC_API_VERSION } from "../src/node-base.js";

async function listen(server: ReturnType<typeof createHttpServer>): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function rpcHeaders(): Record<string, string> {
  return { "x-zyron-rpc-version": String(RPC_API_VERSION) };
}

test("canonical RPC JSON responses advertise the API version", async () => {
  const server = createRpcServer({} as NodeService);
  const running = await listen(server);
  try {
    const response = await fetch(`${running.base}/rpc-info`, { headers: rpcHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-zyron-rpc-version"), String(RPC_API_VERSION));
  } finally {
    await running.close();
  }
});

test("early RPC concurrency rejection advertises the API version", async () => {
  const server = createRpcServer({} as NodeService, { maxInflightRequests: 1 });
  const running = await listen(server);
  const target = new URL(`${running.base}/tx`);
  const blocker = request({
    hostname: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: "POST",
    headers: {
      ...rpcHeaders(),
      "content-type": "application/json",
      "content-length": "2"
    }
  });
  blocker.on("error", () => undefined);
  blocker.write("{");
  try {
    await new Promise<void>((resolve) => {
      const socket = blocker.socket;
      if (socket?.readyState === "open") return resolve();
      blocker.once("socket", (assigned) => assigned.once("connect", resolve));
    });

    let response: Response | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      response = await fetch(`${running.base}/rpc-info`, { headers: rpcHeaders() });
      if (response.status === 503) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(response);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-zyron-rpc-version"), String(RPC_API_VERSION));
  } finally {
    blocker.destroy();
    await running.close();
  }
});

test("peer HTTP client fails closed when a response omits the API version", async () => {
  const server = createHttpServer((_request, response) => {
    const body = "{}";
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
  });
  const running = await listen(server);
  try {
    const client = new PeerClient([running.base]);
    await assert.rejects(
      client.fetchPeerRecord(running.base, { chainId: "rpc-version-test", genesisHash: "00".repeat(32) }),
      /Peer response is missing RPC API version/
    );
  } finally {
    await running.close();
  }
});
