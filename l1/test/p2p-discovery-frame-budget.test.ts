import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "src/p2p-discovery.ts"), "utf8");

test("native discovery uses a smaller request ceiling than the response ceiling", () => {
  assert.match(source, /const MAX_DISCOVERY_REQUEST_BYTES = 2_048;/);
  assert.match(source, /const MAX_DISCOVERY_RESPONSE_BYTES = 20_000;/);
  assert.doesNotMatch(source, /MAX_DISCOVERY_FRAME_BYTES/);
});

test("native discovery applies request and response ceilings in the correct directions", () => {
  assert.match(
    source,
    /readP2PFrameRetained\(stream, MAX_DISCOVERY_REQUEST_BYTES, P2P_DISCOVERY_TIMEOUT_MS\)/
  );
  assert.match(
    source,
    /satisfies DiscoveryResponse,\s*\n\s*MAX_DISCOVERY_RESPONSE_BYTES, P2P_DISCOVERY_TIMEOUT_MS\)/
  );
  assert.match(
    source,
    /satisfies DiscoveryRequest,\s*\n\s*MAX_DISCOVERY_REQUEST_BYTES, P2P_DISCOVERY_TIMEOUT_MS\)/
  );
  assert.match(
    source,
    /readP2PFrameRetained\(stream, MAX_DISCOVERY_RESPONSE_BYTES, P2P_DISCOVERY_TIMEOUT_MS\)/
  );
});
