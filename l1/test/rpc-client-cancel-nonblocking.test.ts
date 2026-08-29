import test from "node:test";
import assert from "node:assert/strict";
import { readBoundedResponseText } from "../src/rpc-client.js";

test("bounded RPC oversize rejection does not await reader cancellation", async () => {
  let cancelCalls = 0;
  let releaseCalls = 0;
  const reader = {
    read: async () => ({ done: false, value: new Uint8Array(9) }),
    cancel: () => {
      cancelCalls += 1;
      return new Promise<void>(() => {});
    },
    releaseLock: () => {
      releaseCalls += 1;
    }
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;

  const response = {
    headers: { get: () => null },
    body: { getReader: () => reader }
  } as unknown as Response;

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for fail-closed oversize rejection")), 250);
    timer.unref?.();
  });

  await assert.rejects(
    Promise.race([readBoundedResponseText(response, 8), timeout]),
    /RPC response too large/
  );
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
});
