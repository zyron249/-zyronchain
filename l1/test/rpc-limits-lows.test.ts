// P1-02 follow-ups (docs/RPC_LIMITS_REVIEW.md):
//
// P1-02-M3 (was L1): the public testnet gateways reach their validators over
//   loopback, so every public read, submit, faucet and health request, and the
//   validators' own peer traffic, shared one 600/min node RPC bucket for
//   127.0.0.1. One unthrottled client (GET /health fans out to every
//   validator) or a few clients at the gateway's per-client read limit
//   exhausted it. A node can now exempt exact loopback addresses (a
//   co-located gateway that enforces its own per-client limits) from the
//   per-client window; nothing else is exempt.
// P1-02-L2: optional per-client POST /tx window, counted before the body is
//   read.
// P1-02-L3: a reader that stops reading held its response bytes in the
//   node-wide response budget indefinitely (no socket idle timeout), so a few
//   large /blocks responses could make every other response fail with 503.
//   Idle sockets are now closed, which releases the reservation.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createRpcServer, NodeService } from "../src/node-base.js";
import { ChainStore } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

type Options = NonNullable<Parameters<typeof createRpcServer>[1]> & {
  rateLimitExemptAddresses?: string[];
  submitRequestsPerWindow?: number;
  socketIdleTimeoutMs?: number;
};

function genesis(): GenesisConfig {
  const keys = ["b1", "b2", "b3"].map((byte) => publicKeyFromPrivate(byte.padStart(64, "0")));
  return {
    chainId: "zyron-rpc-limits-lows-1",
    timestampMs: 1_700_000_000_000,
    validators: keys.slice(0, 2).map((publicKey) => ({ address: addressFromPublicKey(publicKey), publicKey })),
    activityOracles: [keys[2]!],
    activityPool: addressFromPublicKey(keys[2]!),
    allocations: [{ address: addressFromPublicKey(keys[2]!), amountAtoms: 1_000_000 }]
  };
}

async function withServer(
  options: Options,
  run: (port: number, service: NodeService) => Promise<void>,
  prepare: (service: NodeService) => void = () => undefined
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zyron-rpc-lows-"));
  const store = await ChainStore.open(genesis(), directory);
  const service = new NodeService(store);
  prepare(service);
  const server = createRpcServer(service, options);
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => done()); });
    await run((server.address() as AddressInfo).port, service);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}

function call(
  port: number,
  method: string,
  path: string,
  body?: string,
  localAddress = "127.0.0.1"
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, path, method, localAddress,
      headers: { connection: "close", ...(body === undefined ? {} : { "content-type": "application/json" }) }
    }, (res) => {
      res.resume();
      res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("P1-02-M3: an exempt loopback address skips the per-client window; other callers keep it", async () => {
  await withServer({ requestsPerWindow: 2, rateLimitExemptAddresses: ["127.0.0.1"] }, async (port) => {
    const exempt: number[] = [];
    for (let index = 0; index < 6; index += 1) exempt.push((await call(port, "GET", "/status")).status);
    assert.deepEqual(exempt, [200, 200, 200, 200, 200, 200]);
    // Another loopback address is not exempt and keeps the 2-per-window limit.
    const other: number[] = [];
    for (let index = 0; index < 3; index += 1) other.push((await call(port, "GET", "/status", undefined, "127.0.0.2")).status);
    assert.deepEqual(other, [200, 200, 429]);
  });
});

test("P1-02-M3: without the option every caller, including loopback, keeps the per-client window", async () => {
  await withServer({ requestsPerWindow: 2 }, async (port) => {
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) statuses.push((await call(port, "GET", "/status")).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

test("P1-02-M3: only loopback IP literals can be exempt, never a trusted proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-rpc-lows-cfg-"));
  try {
    const service = new NodeService(await ChainStore.open(genesis(), directory));
    for (const address of ["203.0.113.5", "10.0.0.1", "::2", "::ffff:10.0.0.1", "localhost", "", "127.0.0.1:80"]) {
      assert.throws(() => createRpcServer(service, { rateLimitExemptAddresses: [address] } as Options), /exempt/i, address);
    }
    assert.throws(
      () => createRpcServer(service, { rateLimitExemptAddresses: ["127.0.0.1"], trustedProxyAddresses: ["127.0.0.1"] } as Options),
      /exempt/i
    );
    assert.throws(
      () => createRpcServer(service, { rateLimitExemptAddresses: Array.from({ length: 17 }, (_, i) => `127.0.0.${i + 1}`) } as Options),
      /exempt/i
    );
    for (const address of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) {
      createRpcServer(service, { rateLimitExemptAddresses: [address] } as Options).close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("P1-02-L2: optional per-client POST /tx window counted before the body is read", async () => {
  await withServer({ requestsPerWindow: 100, submitRequestsPerWindow: 2 }, async (port) => {
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) statuses.push((await call(port, "POST", "/tx", "{}")).status);
    assert.deepEqual(statuses, [400, 400, 429]);
    const limited = await call(port, "POST", "/tx", "{}");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    // Reads keep the general window.
    assert.equal((await call(port, "GET", "/status")).status, 200);
    // Another client has its own submit quota.
    assert.equal((await call(port, "POST", "/tx", "{}", "127.0.0.2")).status, 400);
  });
});

test("P1-02-L2: without the option POST /tx keeps only the general per-client window", async () => {
  await withServer({ requestsPerWindow: 100 }, async (port) => {
    for (let index = 0; index < 5; index += 1) assert.equal((await call(port, "POST", "/tx", "{}")).status, 400);
  });
});

test("P1-02-L3: a reader that stops reading cannot hold the response budget past the idle timeout", async () => {
  const payload = "x".repeat(15_000_000);
  await withServer(
    { maxInflightResponseBytes: 18_000_000, socketIdleTimeoutMs: 1_000, rateLimitExemptAddresses: ["127.0.0.1"] },
    async (port) => {
      assert.equal((await call(port, "GET", "/status")).status, 200);
      const stalled = connect(port, "127.0.0.1");
      stalled.pause();
      stalled.write("GET /blocks?from=1&limit=1 HTTP/1.1\r\nHost: node\r\n\r\n");
      try {
        await sleep(300);
        // While the 15 MB response is held, a 4 MB serialization allowance does not fit.
        assert.equal((await call(port, "GET", "/status")).status, 503);
        const deadline = Date.now() + 10_000;
        let status = 503;
        while (Date.now() < deadline && status === 503) {
          await sleep(250);
          status = (await call(port, "GET", "/status")).status;
        }
        assert.equal(status, 200, "response budget still held by a reader that stopped reading");
      } finally {
        stalled.destroy();
      }
    },
    (service) => {
      (service as unknown as { blocks: () => Promise<unknown[]> }).blocks = async () => [{ pad: payload }];
    }
  );
});

test("P1-02-L3: the node RPC sets a finite socket idle timeout by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-rpc-lows-idle-"));
  try {
    const server = createRpcServer(new NodeService(await ChainStore.open(genesis(), directory)));
    assert.ok(server.timeout > 0 && server.timeout <= 60_000, `server.timeout=${server.timeout}`);
    server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
