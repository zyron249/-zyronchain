import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { nativeConsensusRequestMaxBytes } from "../src/p2p-consensus.js";

test("native consensus client request budgets remain kind-specific", () => {
  assert.equal(nativeConsensusRequestMaxBytes("attest"), 2_500_000);
  assert.equal(nativeConsensusRequestMaxBytes("block"), 2_500_000);
  assert.equal(nativeConsensusRequestMaxBytes("skip"), 128_000);
  assert.equal(nativeConsensusRequestMaxBytes("transaction"), 64_000);
  assert.ok(nativeConsensusRequestMaxBytes("skip") < nativeConsensusRequestMaxBytes("attest"));
  assert.ok(nativeConsensusRequestMaxBytes("transaction") < nativeConsensusRequestMaxBytes("block"));
});

test("native consensus client writes use the request-kind budget while server reads stay block-sized", () => {
  const source = readFileSync(resolve(process.cwd(), "src/p2p-consensus.ts"), "utf8");
  assert.match(
    source,
    /writeP2PFrame\(stream, request, nativeConsensusRequestMaxBytes\(request\.kind\), P2P_CONSENSUS_TIMEOUT_MS\)/
  );
  assert.match(
    source,
    /readP2PFrameRetained\(stream, MAX_CONSENSUS_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS\)/
  );
  assert.doesNotMatch(
    source,
    /writeP2PFrame\(stream, request, MAX_CONSENSUS_FRAME_BYTES, P2P_CONSENSUS_TIMEOUT_MS\)/
  );
});
