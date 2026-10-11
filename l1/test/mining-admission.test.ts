import assert from "node:assert/strict";
import test from "node:test";

import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { INITIAL_MINING_REWARD_ATOMS } from "../src/mining.js";
import { createMiningClaim } from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivate = "21".padStart(64, "0");
const minerPrivate = "22".padStart(64, "0");
const oraclePrivate = "23".padStart(64, "0");
const poolPrivate = "24".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const minerPublic = publicKeyFromPrivate(minerPrivate);
const oraclePublic = publicKeyFromPrivate(oraclePrivate);
const poolPublic = publicKeyFromPrivate(poolPrivate);
const validator = addressFromPublicKey(validatorPublic);
const miner = addressFromPublicKey(minerPublic);
const pool = addressFromPublicKey(poolPublic);

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-mining-admission-test",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validator, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 0 }]
  };
}

// RETIRED (owner decision 2026-09-30): mining is shut down for every genesis.
// This test previously proved future-nonce claims were rejected before proof
// validation; it now proves every claim (future or exact nonce) is rejected by
// the retirement guard even when protocol v5 is forced on.
test("mining mempool admission rejects every mining claim (mining retired), including under forced protocol v5", () => {
  const chain = new ZyronChain(genesis());
  (chain as unknown as { protocolVersionAt(height: number): number }).protocolVersionAt = () => 5;
  for (const nonce of [1, 2]) {
    const claim = createMiningClaim({
      chainId: chain.genesis.chainId,
      nonce,
      sender: miner,
      height: chain.height + 1,
      previousHash: chain.tip.hash,
      rewardAtoms: INITIAL_MINING_REWARD_ATOMS,
      workNonce: "0000000000000000",
      timestampMs: chain.genesis.timestampMs + 1
    }, minerPrivate, minerPublic);
    assert.equal(chain.nonce(miner), 0);
    assert.throws(() => chain.validateMempoolAdmission(claim), /Mining is retired/);
  }
  assert.equal(chain.nextMiningRewardAtoms(), 0);
  assert.equal(chain.balance(miner), 0);
});
