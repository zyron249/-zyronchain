import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("native sync response budget stays close to the bounded block payload envelope", async () => {
  const syncSource = await readFile(resolve(process.cwd(), "src/p2p-sync.ts"), "utf8");
  const nodeSource = await readFile(resolve(process.cwd(), "src/node-base.ts"), "utf8");

  const nativeMatch = syncSource.match(/NATIVE_SYNC_RESPONSE_MAX_BYTES = ([0-9_]+)/);
  const payloadMatch = nodeSource.match(/MAX_SYNC_BATCH_PAYLOAD_BYTES = ([0-9_]+)/);
  const genericMatch = nodeSource.match(/MAX_SYNC_RESPONSE_BYTES = ([0-9_]+)/);
  assert.ok(nativeMatch && payloadMatch && genericMatch, "expected sync byte-budget constants");

  const nativeMax = Number(nativeMatch[1]!.replaceAll("_", ""));
  const payloadMax = Number(payloadMatch[1]!.replaceAll("_", ""));
  const genericMax = Number(genericMatch[1]!.replaceAll("_", ""));

  assert.equal(payloadMax, 20_000_000);
  assert.equal(nativeMax, 21_000_000);
  assert.ok(nativeMax >= payloadMax + 1_000_000, "native response needs bounded identity/status/JSON headroom");
  assert.ok(nativeMax < genericMax, "native transport must not regress to the generic HTTP sync ceiling");

  assert.match(
    syncSource,
    /writeP2PFrame\(stream, response, NATIVE_SYNC_RESPONSE_MAX_BYTES, P2P_SYNC_TIMEOUT_MS\)/,
    "server response writes must use the native sync ceiling"
  );
  assert.match(
    syncSource,
    /readP2PFrameRetained\(stream, NATIVE_SYNC_RESPONSE_MAX_BYTES, P2P_SYNC_TIMEOUT_MS\)/,
    "client retained reads must use the same native sync ceiling"
  );
  assert.doesNotMatch(
    syncSource,
    /writeP2PFrame\(stream, response, MAX_SYNC_RESPONSE_BYTES/,
    "native server writes must not reuse the generic HTTP sync ceiling"
  );
});
