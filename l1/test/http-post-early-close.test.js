// T-D31-1: regression tests for test/support/http-post.ts, the POST helper used
// by the RPC boundary tests whose server refuses a body before reading it.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { postAllowingEarlyClose } from "./support/http-post.js";
// Larger than loopback socket buffers, so the client is still writing when the
// response arrives (asserted below, the scenario is not vacuous).
const LARGE_BODY_BYTES = 32 * 1024 * 1024;
const REFUSAL_BODY = '{"error":"Peer authentication required"}';
function refusal(connection) {
    return "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n" +
        `connection: ${connection}\r\ncontent-length: ${Buffer.byteLength(REFUSAL_BODY)}\r\n\r\n${REFUSAL_BODY}`;
}
const REFUSAL = refusal("keep-alive");
// A hang here would mean the helper waits forever for a body the server will never read.
const NO_HANG = { timeout: 15_000 };
// Which of these surfaces first depends on platform and timing; any of them is a rejection.
function isConnectionClosedError(error) {
    return ["ECONNRESET", "EPIPE", "ECANCELED"].includes(error.code ?? "");
}
async function withRawServer(onConnection, run) {
    const sockets = new Set();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.once("close", () => sockets.delete(socket));
        onConnection(socket);
    });
    try {
        await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => done()); });
        await run(server.address().port);
    }
    finally {
        for (const socket of sockets)
            socket.destroy();
        await new Promise((done) => server.close(() => done()));
    }
}
test("early refusal: a server reset while the body is still being written keeps the refusal status and never throws uncaught", async () => {
    const uncaught = [];
    const onUncaught = (error) => { uncaught.push(error); };
    process.on("uncaughtException", onUncaught);
    try {
        let serverSocket;
        await withRawServer((socket) => {
            serverSocket = socket;
            // Refuse from the request head without reading the body.
            socket.once("data", () => {
                socket.pause();
                socket.write(REFUSAL);
            });
        }, async (port) => {
            let writeFinishedAtResponseEnd;
            const result = await postAllowingEarlyClose(port, "/v6/commit", Buffer.alloc(LARGE_BODY_BYTES, 0x61), {}, (request) => {
                request.on("response", (response) => response.on("end", () => {
                    writeFinishedAtResponseEnd = request.writableFinished;
                    // Reset only after the complete response was received, as the RPC test teardown does.
                    serverSocket.resetAndDestroy();
                }));
            });
            assert.equal(writeFinishedAtResponseEnd, false, "the body write must still be pending when the response ends");
            assert.equal(result.status, 401);
            assert.equal(result.body, REFUSAL_BODY);
            assert.match(result.earlyClose ?? "", /^(read|write|socket) (ECONNRESET|EPIPE|ECANCELED)$/);
        });
        // Give any late socket error a chance to surface.
        await new Promise((done) => setTimeout(done, 50));
        assert.deepEqual(uncaught, []);
    }
    finally {
        process.off("uncaughtException", onUncaught);
    }
});
test("early refusal: the helper resolves only after the body write has settled, so callers never tear down mid-write", async () => {
    let serverSocket;
    await withRawServer((socket) => {
        serverSocket = socket;
        socket.once("data", () => {
            socket.pause();
            socket.write(REFUSAL);
        });
    }, async (port) => {
        let request;
        let writeFinishedAtResponseEnd;
        const result = await postAllowingEarlyClose(port, "/tx", Buffer.alloc(LARGE_BODY_BYTES, 0x61), {}, (clientRequest) => {
            request = clientRequest;
            clientRequest.on("response", (response) => response.on("end", () => {
                writeFinishedAtResponseEnd = clientRequest.writableFinished;
                // Like the RPC server after a refusal, drain (discard) the unread body.
                serverSocket.on("data", () => undefined);
                serverSocket.resume();
            }));
        });
        assert.equal(writeFinishedAtResponseEnd, false, "the body write must still be pending when the response ends");
        assert.equal(request?.writableFinished, true, "resolved before the body write settled");
        assert.equal(result.earlyClose, undefined);
        assert.equal(result.status, 401);
        assert.equal(result.body, REFUSAL_BODY);
    });
});
for (const [name, connection] of [
    ["Connection: close, then a clean half-close", "close"],
    ["keep-alive, then a clean FIN", "keep-alive"]
]) {
    test(`early refusal: ${name} without reading the body resolves with the refusal instead of hanging`, NO_HANG, async () => {
        await withRawServer((socket) => {
            socket.once("data", () => {
                // Never read the body; answer, then end our side cleanly (FIN, no reset).
                socket.pause();
                socket.write(refusal(connection));
                socket.end();
            });
        }, async (port) => {
            const result = await postAllowingEarlyClose(port, "/tx", Buffer.alloc(LARGE_BODY_BYTES, 0x61));
            assert.equal(result.status, 401);
            assert.equal(result.body, REFUSAL_BODY);
            assert.match(result.earlyClose ?? "", /^server closed \((connection: close|FIN)\)$|^(read|write|socket) (ECONNRESET|EPIPE|ECANCELED)$/);
        });
    });
}
test("early refusal: a reset before any response still rejects", async () => {
    await withRawServer((socket) => {
        socket.once("data", () => socket.resetAndDestroy());
    }, async (port) => {
        await assert.rejects(postAllowingEarlyClose(port, "/v6/commit", Buffer.alloc(LARGE_BODY_BYTES, 0x61)), isConnectionClosedError);
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
        await assert.rejects(postAllowingEarlyClose(port, "/v6/commit", Buffer.alloc(LARGE_BODY_BYTES, 0x61)), isConnectionClosedError);
    });
});
