import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  MAX_STATE_KEYS_PER_CHUNK,
  MAX_STATE_KEY_RESPONSE_BYTES,
  MAX_STATE_MANIFEST_BYTES,
  MAX_STATE_RECORD_RESPONSE_BYTES,
  stateResponseMaxBytes
} from "../src/p2p-state.js";

test("State-v2 response ceilings are request-kind specific", () => {
  assert.equal(stateResponseMaxBytes("manifest"), MAX_STATE_MANIFEST_BYTES);
  assert.equal(stateResponseMaxBytes("records"), MAX_STATE_RECORD_RESPONSE_BYTES);
  assert.equal(stateResponseMaxBytes("keys"), MAX_STATE_KEY_RESPONSE_BYTES);
  assert.equal(MAX_STATE_MANIFEST_BYTES, 2_500_000);
  assert.equal(MAX_STATE_RECORD_RESPONSE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_STATE_KEY_RESPONSE_BYTES, 2 * 1024 * 1024);
  assert.ok(MAX_STATE_KEY_RESPONSE_BYTES < MAX_STATE_RECORD_RESPONSE_BYTES);
});

test("key response ceiling covers worst-case escaped bounded key preimages", () => {
  const key = "\u0000".repeat(256);
  const response = {
    version: 1,
    identity: {
      version: 1,
      nodeId: "n".repeat(128),
      publicKey: "a".repeat(64),
      chainId: "c".repeat(128),
      genesisHash: "b".repeat(64)
    },
    tipHash: "d".repeat(64),
    snapshotSha256: "e".repeat(64),
    kind: "keys",
    start: 0,
    items: Array.from({ length: MAX_STATE_KEYS_PER_CHUNK }, () => key)
  };
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") < MAX_STATE_KEY_RESPONSE_BYTES);
});

test("server writes and client reads share the response-kind ceiling helper", async () => {
  const source = await readFile(resolve(process.cwd(), "src/p2p-state.ts"), "utf8");
  assert.match(source, /writeP2PFrame\([\s\S]*?stateResponseMaxBytes\(request\.kind\)/);
  assert.match(source, /readP2PFrameRetained\([\s\S]*?stateResponseMaxBytes\(kind\)/);
  assert.doesNotMatch(source, /kind === "manifest" \? MAX_STATE_MANIFEST_BYTES : MAX_STATE_RESPONSE_BYTES/);
});
