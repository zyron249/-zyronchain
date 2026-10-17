// T-D31-1: regression tests for test/support/http-post.ts, the POST helper used
// by the RPC boundary tests whose server refuses a body before reading it.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { ClientRequest } from "node:http";

import { postAllowingEarlyClose } from "./support/http-post.js";

// Larger than loopback socket buffers, so the client is still writing when the
// response arrives (asserted below, the scenario is not vacuous).
const LARGE_BODY_BYTES = 64 * 1024 * 1024;
const REFUSAL_BODY = '{"error":"Peer authentication required"}';
const REFUSAL =
  "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\nconnection: keep-alive\r\n" +
  `content-length: ${Buffer.byteLength(REFUSAL_BODY)}\r\n\r\n${REFUSAL_BODY}`;

async function withRawServer(onConnection: (socket: Socket) => void, run: (port: number) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => done()); });
    await run((server.address() as AddressInfo).port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test("early refusal: a server reset while the body is still being written keeps the refusal status and never throws uncaught", async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  process.on("uncaughtException", onUncaught);
  try {
    let serverSocket: Socket | undefined;
    await withRawServer((socket) => {
      serverSocket = socket;
      // Refuse from the request head without reading the body.
      socket.once("data", () => {
        socket.pause();
        socket.write(REFUSAL);
      });
    }, async (port) => {
      let writeFinishedAtResponseEnd: boolean | undefined;
      const result = await postAllowingEarlyClose(port, "/v6/commit", Buffer.alloc(LARGE_BODY_BYTES, 0x61), {}, (request) => {
        request.on("response", (response) => response.on("end", () => {
          writeFinishedAtResponseEnd = request.writableFinished;
          // Reset only after the complete response was received, as the RPC test teardown does.
          serverSocket!.resetAndDestroy();
        }));
      });
      assert.equal(writeFinishedAtResponseEnd, false, "the body write must still be pending when the response ends");
      assert.equal(result.status, 401);
      assert.equal(result.body, REFUSAL_BODY);
      assert.match(result.earlyClose ?? "", /^(read|write|socket) (ECONNRESET|EPIPE)$/);
    });
    // Give any late socket error a chance to surface.
    await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

test("early refusal: the helper resolves only after the body write has settled, so callers never tear down mid-write", async () => {
  let serverSocket: Socket | undefined;
  await withRawServer((socket) => {
    serverSocket = socket;
    socket.once("data", () => {
      socket.pause();
      socket.write(REFUSAL);
    });
  }, async (port) => {
    let request: ClientRequest | undefined;
    let writeFinishedAtResponseEnd: boolean | undefined;
    const result = await postAllowingEarlyClose(port, "/tx", Buffer.alloc(LARGE_BODY_BYTES, 0x61), {}, (clientRequest) => {
      request = clientRequest;
      clientRequest.on("response", (response) => response.on("end", () => {
        writeFinishedAtResponseEnd = clientRequest.writableFinished;
        // Like the RPC server after a refusal, drain (discard) the unread body.
        serverSocket!.on("data", () => undefined);
        serverSocket!.resume();
      }));
    });
    assert.equal(writeFinishedAtResponseEnd, false, "the body write must still be pending when the response ends");
    assert.equal(request?.writableFinished, true, "resolved before the body write settled");
    assert.equal(result.earlyClose, undefined);
    assert.equal(result.status, 401);
    assert.equal(result.body, REFUSAL_BODY);
  });
});

test("early refusal: a reset before any response still rejects", async () => {
  await withRawServer((socket) => {
    socket.once("data", () => socket.resetAndDestroy());
  }, async (port) => {
    await assert.rejects(
      postAllowingEarlyClose(port, "/v6/commit", Buffer.alloc(LARGE_BODY_BYTES, 0x61)),
      (error: NodeJS.ErrnoException) => error.code === "ECONNRESET" || error.code === "EPIPE"
    );
  });
});

test("early refusal: a reset in the middle of the response still rejects", async () => {
  await withRawServer((socket) => {
    socket.once("data", () => {
      socket.pause();
      // Headers promise a longer body than is sent before the reset.
      socket.write(REFUSAL.slice(0, REFUSAL.length - 5), () => setTimeout(() => socket.resetAndDestroy(), 20));
    });
  }, async (port) => {
    await assert.rejects(
      postAllowingEarlyClose(port, "/v6/commit", Buffer.alloc(LARGE_BODY_BYTES, 0x61)),
      (error: NodeJS.ErrnoException) => error.code === "ECONNRESET" || error.code === "EPIPE"
    );
  });
});
