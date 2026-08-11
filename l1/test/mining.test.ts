import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ZyronChain } from "../src/chain.js";
import {
  INITIAL_MINING_REWARD_ATOMS,
  MINING_DIFFICULTY_BITS,
  MINING_ERA_TARGET_CLAIMS,
  MINING_TRACKER_ADDRESS,
  cumulativeMiningIssuanceAtoms,
  meetsMiningDifficulty,
  miningEraForClaimCount,
  miningRewardAtoms,
  miningWorkHash
} from "../src/mining.js";
import { LedgerState } from "../src/state.js";
import {
  SparseMerkleState,
  applyStateV2Transaction,
  stateV2TransactionKeyPreimages
} from "../src/state-v2.js";
import { createMiningClaim, validateTransactionShape } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type GenesisConfig, type MiningClaimTx } from "../src/types.js";

const validatorPrivate = "11".padStart(64, "0");
const minerPrivate = "12".padStart(64, "0");
const oraclePrivate = "13".padStart(64, "0");
const poolPrivate = "14".padStart(64, "0");

const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const minerPublic = publicKeyFromPrivate(minerPrivate);
const oraclePublic = publicKeyFromPrivate(oraclePrivate);
const poolPublic = publicKeyFromPrivate(poolPrivate);
const validator = addressFromPublicKey(validatorPublic);
const miner = addressFromPublicKey(minerPublic);
const pool = addressFromPublicKey(poolPublic);

function genesis(allocations: GenesisConfig["allocations"] = [{ address: pool, amountAtoms: 0 }]): GenesisConfig {
  return {
    chainId: "zyron-mining-test-1",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validator, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool: pool,
    allocations
  };
}

function unsignedContext(overrides: Partial<Parameters<typeof createMiningClaim>[0]> = {}) {
  return {
    chainId: genesis().chainId,
    nonce: 1,
    sender: miner,
    height: 1,
    previousHash: "ab".repeat(32),
    rewardAtoms: INITIAL_MINING_REWARD_ATOMS,
    workNonce: "0000000000000000",
    timestampMs: genesis().timestampMs + 1,
    ...overrides
  };
}

test("mining issuance starts at 6.25 ZYN and halves every four million finalized claims", () => {
  assert.equal(INITIAL_MINING_REWARD_ATOMS, 6.25 * ATOMS_PER_ZYN);
  assert.equal(MINING_ERA_TARGET_CLAIMS, 4_000_000);
  assert.equal(miningEraForClaimCount(0), 0);
  assert.equal(miningEraForClaimCount(3_999_999), 0);
  assert.equal(miningEraForClaimCount(4_000_000), 1);
  assert.equal(miningRewardAtoms(0, 0), 625_000_000);
  assert.equal(miningRewardAtoms(4_000_000, 0), 312_500_000);
  assert.equal(miningRewardAtoms(8_000_000, 0), 156_250_000);
  assert.equal(cumulativeMiningIssuanceAtoms(4_000_000, 0), 25_000_000 * ATOMS_PER_ZYN);
  assert.equal(cumulativeMiningIssuanceAtoms(8_000_000, 0), 37_500_000 * ATOMS_PER_ZYN);
});

test("historical mining issuance never reopens burned supply and never exceeds the 50M cap", () => {
  const tenMillionPremine = 10_000_000 * ATOMS_PER_ZYN;
  const hugeClaimCount = 400_000_000;
  const issued = cumulativeMiningIssuanceAtoms(hugeClaimCount, tenMillionPremine);
  assert.equal(issued, MAX_SUPPLY_ATOMS - tenMillionPremine);
  assert.equal(miningRewardAtoms(hugeClaimCount, tenMillionPremine), 0);
  assert.throws(() => miningRewardAtoms(-1, 0), /Invalid finalized mining claim count/);
  assert.throws(() => miningRewardAtoms(0, MAX_SUPPLY_ATOMS + 1), /Invalid genesis ZYN supply/);
});

test("difficulty check is an exact 256-bit target comparison", () => {
  assert.equal(MINING_DIFFICULTY_BITS, 20);
  assert.equal(meetsMiningDifficulty("0".repeat(5) + "f".repeat(59)), true);
  assert.equal(meetsMiningDifficulty("0".repeat(4) + "1" + "0".repeat(59)), false);
  assert.equal(meetsMiningDifficulty("not-a-hash"), false);
});

test("mining work is bound to miner, height, previous finalized hash, reward and account nonce", () => {
  const base = {
    chainId: genesis().chainId,
    nonce: 1,
    sender: miner,
    height: 101,
    previousHash: "cd".repeat(32),
    rewardAtoms: INITIAL_MINING_REWARD_ATOMS,
    workNonce: "00000000000000aa",
    publicKey: minerPublic
  };
  const hash = miningWorkHash(base);
  assert.notEqual(miningWorkHash({ ...base, height: 102 }), hash);
  assert.notEqual(miningWorkHash({ ...base, previousHash: "ef".repeat(32) }), hash);
  assert.notEqual(miningWorkHash({ ...base, nonce: 2 }), hash);
  assert.notEqual(miningWorkHash({ ...base, rewardAtoms: base.rewardAtoms - 1 }), hash);
  assert.notEqual(miningWorkHash({ ...base, sender: validator, publicKey: validatorPublic }), hash);
});

test("mining claim is a version-2 signed transaction with fail-closed shape validation", () => {
  const claim = createMiningClaim(unsignedContext(), minerPrivate, minerPublic);
  assert.equal(claim.kind, "mining_claim");
  assert.equal(claim.version, 2);
  assert.equal(claim.feeAtoms, 0);
  assert.doesNotThrow(() => validateTransactionShape(claim));

  const malformed = { ...claim, workNonce: "xyz" };
  assert.throws(() => validateTransactionShape(malformed), /Invalid mining work nonce/);

  const wrongReward = { ...claim, rewardAtoms: 0 };
  assert.throws(() => validateTransactionShape(wrongReward), /mining reward must be positive/);
});

test("mining cannot enter a legacy protocol mempool before protocol v4 activation", () => {
  const chain = new ZyronChain(genesis());
  const claim = createMiningClaim(unsignedContext({ previousHash: chain.tip.hash }), minerPrivate, minerPublic);
  assert.throws(
    () => chain.validateMempoolAdmission(claim),
    /Transaction version 2 is not valid under protocol version 1/
  );
});

test("ledger mining issuance credits the miner and advances the consensus-owned global claim counter", () => {
  const state = LedgerState.fromGenesis(genesis());
  const claim = createMiningClaim(unsignedContext(), minerPrivate, minerPublic);
  state.apply(claim, pool);
  assert.equal(state.balance(miner), INITIAL_MINING_REWARD_ATOMS);
  assert.equal(state.nonce(miner), 1);
  assert.equal(state.balance(MINING_TRACKER_ADDRESS), 0);
  assert.equal(state.miningClaimCount(), 1);
});

test("State-v2 semantic keys commit both miner account and mining claim counter", () => {
  const claim = createMiningClaim(unsignedContext(), minerPrivate, minerPublic);
  const keys = stateV2TransactionKeyPreimages(claim);
  assert.deepEqual(keys, [
    `account:${MINING_TRACKER_ADDRESS}`,
    `account:${miner}`
  ].sort());
  assert.throws(
    () => applyStateV2Transaction(SparseMerkleState.empty(), claim, pool),
    /Mining claim requires chain-context State-v2 application/
  );
});

test("reserved mining tracker cannot be preallocated or used as the activity pool", () => {
  assert.throws(
    () => new ZyronChain(genesis([{ address: MINING_TRACKER_ADDRESS, amountAtoms: 0 }])),
    /Mining tracker cannot receive a genesis allocation/
  );
  assert.throws(
    () => new ZyronChain({ ...genesis(), activityPool: MINING_TRACKER_ADDRESS }),
    /Mining tracker cannot be the activity pool/
  );
});

test("tracker address cannot claim mining rewards even with a structurally valid signed object", () => {
  const state = LedgerState.fromGenesis(genesis());
  const regular = createMiningClaim(unsignedContext(), minerPrivate, minerPublic);
  const forgedTracker = {
    ...regular,
    sender: MINING_TRACKER_ADDRESS
  } as MiningClaimTx;
  assert.throws(() => state.apply(forgedTracker, pool), /protocol-reserved/);
});
