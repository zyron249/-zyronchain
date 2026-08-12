import assert from "node:assert/strict";
import test from "node:test";

import { assertMiningNetworkIdentity, miningChallengeMatchesFinalizedTip } from "../src/miner-network.js";

const expectedChainId = "zyron-beta-1";
const expectedGenesisHash = "11".repeat(32);
const tipHash = "22".repeat(32);

function status(overrides: Record<string, unknown> = {}) {
  return {
    chainId: expectedChainId,
    genesisHash: expectedGenesisHash,
    height: 42,
    tipHash,
    ...overrides
  };
}

test("miner accepts exact canonical chain and genesis identity", () => {
  assert.doesNotThrow(() => assertMiningNetworkIdentity(status(), expectedChainId, expectedGenesisHash));
});

test("miner fails closed on same-chain-id genesis mismatch", () => {
  assert.throws(
    () => assertMiningNetworkIdentity(status({ genesisHash: "33".repeat(32) }), expectedChainId, expectedGenesisHash),
    /Genesis hash does not match RPC genesis hash/
  );
});

test("miner fails closed on chain-id mismatch", () => {
  assert.throws(
    () => assertMiningNetworkIdentity(status({ chainId: "other-chain" }), expectedChainId, expectedGenesisHash),
    /Genesis chain ID does not match RPC chain ID/
  );
});

test("miner rejects malformed RPC genesis identity before hashing", () => {
  for (const genesisHash of [undefined, "", "aa", "GG".repeat(32)]) {
    assert.throws(
      () => assertMiningNetworkIdentity(status({ genesisHash }), expectedChainId, expectedGenesisHash),
      /RPC returned invalid chain status/
    );
  }
});

test("miner submits only while the solved challenge still matches the finalized tip", () => {
  const challenge = { height: 43, previousHash: tipHash };
  assert.equal(miningChallengeMatchesFinalizedTip({ height: 42, tipHash }, challenge), true);
  assert.equal(miningChallengeMatchesFinalizedTip({ height: 43, tipHash: "44".repeat(32) }, challenge), false);
  assert.equal(miningChallengeMatchesFinalizedTip({ height: 42, tipHash: "55".repeat(32) }, challenge), false);
});
