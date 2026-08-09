import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import { BackgroundTaskTracker, drainHttpServer } from "../src/node-lifecycle.js";

test("HTTP shutdown drain completes normally when no requests are active", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  await listen(server);
  assert.equal(await drainHttpServer(server, 500), "drained");
  assert.equal(server.listening, false);
});

test("HTTP shutdown drain force-closes a request that exceeds its deadline", async () => {
  let markRequestStarted: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolveStarted) => {
    markRequestStarted = resolveStarted;
  });
  const server = createServer(() => {
    markRequestStarted?.();
    // Deliberately leave the response open to model a stuck/hostile client.
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address");

  const socket = connect(address.port, "127.0.0.1");
  await once(socket, "connect");
  const socketClosed = once(socket, "close");
  socket.write("GET /stuck HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
  await requestStarted;

  const startedAt = Date.now();
  const result = await drainHttpServer(server, 75);
  const elapsedMs = Date.now() - startedAt;
  await socketClosed;

  assert.equal(result, "forced");
  assert.ok(elapsedMs >= 50, `drain forced too early after ${elapsedMs} ms`);
  assert.ok(elapsedMs < 2_000, `drain exceeded its bounded deadline: ${elapsedMs} ms`);
  assert.equal(server.listening, false);
  assert.equal(socket.destroyed, true);
});

test("HTTP shutdown drain rejects unsafe grace periods", async () => {
  const server = createServer();
  await assert.rejects(() => drainHttpServer(server, 0), /grace period/);
});

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

test("background task tracker blocks shutdown until started work settles", async () => {
  const tracker = new BackgroundTaskTracker();
  let releaseTask: (() => void) | undefined;
  const blocked = new Promise<void>((resolveTask) => {
    releaseTask = resolveTask;
  });
  assert.equal(tracker.run(() => blocked), true);
  assert.equal(tracker.pendingCount, 1);

  let drained = false;
  const drain = tracker.drain().then(() => { drained = true; });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(drained, false);
  assert.equal(tracker.run(async () => undefined), false);

  releaseTask?.();
  await drain;
  assert.equal(drained, true);
  assert.equal(tracker.pendingCount, 0);
});

test("background task tracker drains rejected work without leaking rejection", async () => {
  const tracker = new BackgroundTaskTracker();
  assert.equal(tracker.run(async () => { throw new Error("expected test failure"); }), true);
  await tracker.drain();
  assert.equal(tracker.pendingCount, 0);
});
