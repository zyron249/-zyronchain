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

test("mining mempool admission rejects future account nonces before proof validation", () => {
  const chain = new ZyronChain(genesis());
  // Isolate the protocol-v5 admission rule without building a 100-block
  // governance activation fixture. The claim intentionally has no valid PoW;
  // exact confirmed-nonce admission must fail before proof verification.
  (chain as unknown as { protocolVersionAt(height: number): number }).protocolVersionAt = () => 5;
  const claim = createMiningClaim({
    chainId: chain.genesis.chainId,
    nonce: 2,
    sender: miner,
    height: chain.height + 1,
    previousHash: chain.tip.hash,
    rewardAtoms: INITIAL_MINING_REWARD_ATOMS,
    workNonce: "0000000000000000",
    timestampMs: chain.genesis.timestampMs + 1
  }, minerPrivate, minerPublic);

  assert.equal(chain.nonce(miner), 0);
  assert.throws(
    () => chain.validateMempoolAdmission(claim),
    /Mining claim nonce must be next confirmed nonce/
  );
});
