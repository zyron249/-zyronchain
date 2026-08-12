import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ZyronChain } from "../src/chain.js";
import { MAX_MINING_MEMPOOL_CLAIMS, Mempool } from "../src/mempool.js";
import {
  INITIAL_MINING_REWARD_ATOMS,
  MINING_DIFFICULTY_BITS,
  MINING_ERA_TARGET_CLAIMS,
  MINING_PROTOCOL_VERSION,
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
import { ChainStore } from "../src/storage.js";
import {
  createMiningClaim,
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer,
  validateTransactionShape
} from "../src/transaction.js";
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

function policyMiningClaim(index: number, height = 1): MiningClaimTx {
  const base = createMiningClaim(unsignedContext(), minerPrivate, minerPublic);
  return {
    ...base,
    nonce: index + 1,
    height,
    workNonce: index.toString(16).padStart(16, "0"),
    timestampMs: genesis().timestampMs + index + 1,
    txid: index.toString(16).padStart(64, "0")
  };
}

test("mining issuance starts at 6.25 ZYN and halves every four million finalized claims", () => {
  assert.equal(INITIAL_MINING_REWARD_ATOMS, 6.25 * ATOMS_PER_ZYN);
  assert.equal(MINING_ERA_TARGET_CLAIMS, 4_000_000);
  assert.equal(MINING_PROTOCOL_VERSION, 5);
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

test("mining cannot enter a legacy protocol mempool before protocol v5 activation", () => {
  const chain = new ZyronChain(genesis());
  const claim = createMiningClaim(unsignedContext({ previousHash: chain.tip.hash }), minerPrivate, minerPublic);
  assert.throws(
    () => chain.validateMempoolAdmission(claim),
    /Transaction version 2 is not valid under protocol version 1/
  );
});

test("public mining claims are bounded to a 256-entry mempool subpool", () => {
  const mempool = new Mempool();
  for (let index = 0; index < MAX_MINING_MEMPOOL_CLAIMS; index += 1) {
    mempool.add(policyMiningClaim(index));
  }
  assert.equal(mempool.size, MAX_MINING_MEMPOOL_CLAIMS);

  const newerTipClaim = policyMiningClaim(MAX_MINING_MEMPOOL_CLAIMS, 2);
  mempool.add(newerTipClaim);
  assert.equal(mempool.size, MAX_MINING_MEMPOOL_CLAIMS);
  assert.ok(mempool.values().some((tx) => tx.txid === newerTipClaim.txid));
});

test("same proof cannot churn a mining nonce conflict by changing only timestamp and txid", () => {
  const mempool = new Mempool();
  const first = createMiningClaim(unsignedContext({ timestampMs: genesis().timestampMs + 10 }), minerPrivate, minerPublic);
  const replay = createMiningClaim(unsignedContext({ timestampMs: genesis().timestampMs + 20 }), minerPrivate, minerPublic);
  assert.equal(miningWorkHash(first), miningWorkHash(replay));
  assert.notEqual(first.txid, replay.txid);
  mempool.add(first);
  assert.throws(() => mempool.add(replay), /Conflicting sender nonce/);
  assert.equal(mempool.size, 1);
  assert.equal(mempool.values()[0]?.txid, first.txid);
});

test("mining traffic cannot evict a normal transfer from an otherwise full mempool", () => {
  const mempool = new Mempool(1);
  const transfer = createTransfer({
    chainId: genesis().chainId,
    nonce: 1,
    sender: miner,
    receiver: validator,
    amountAtoms: 1,
    feeAtoms: 1,
    timestampMs: genesis().timestampMs + 1
  }, minerPrivate, minerPublic);
  mempool.add(transfer);

  assert.throws(() => mempool.add(policyMiningClaim(10)), /Mining mempool full/);
  assert.equal(mempool.size, 1);
  assert.equal(mempool.values()[0]?.txid, transfer.txid);
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

test("reserved mining tracker cannot be preallocated, paid, spent, or used as the activity pool", () => {
  assert.throws(
    () => new ZyronChain(genesis([{ address: MINING_TRACKER_ADDRESS, amountAtoms: 0 }])),
    /Mining tracker cannot receive a genesis allocation/
  );
  assert.throws(
    () => new ZyronChain({ ...genesis(), activityPool: MINING_TRACKER_ADDRESS }),
    /Mining tracker cannot be the activity pool/
  );

  const toTracker = createTransfer({
    chainId: genesis().chainId,
    nonce: 1,
    sender: miner,
    receiver: MINING_TRACKER_ADDRESS,
    amountAtoms: 1,
    feeAtoms: 0,
    timestampMs: genesis().timestampMs + 1
  }, minerPrivate, minerPublic);
  assert.throws(() => validateTransactionShape(toTracker), /protocol-reserved/);
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

test("protocol v5 activates, finalizes real proof-of-work issuance, and survives trusted-snapshot disk restart", { timeout: 120_000 }, async () => {
  const chain = new ZyronChain(genesis());
  const upgradeInput = {
    chainId: genesis().chainId,
    nonce: 1,
    sender: validator,
    activationHeight: 101,
    protocolVersion: MINING_PROTOCOL_VERSION
  };
  const upgrade = createProtocolUpgrade({
    ...upgradeInput,
    approvals: [createProtocolUpgradeApproval(upgradeInput, validatorPrivate, validatorPublic)],
    timestampMs: genesis().timestampMs + 10
  }, validatorPrivate, validatorPublic);

  for (let height = 1; height <= 100; height += 1) {
    const timestampMs = genesis().timestampMs + (height * 1_000);
    let block = chain.produceBlock(height === 1 ? [upgrade] : [], validatorPrivate, { timestampMs });
    block = chain.attestBlock(block, validatorPrivate);
    chain.acceptBlock(block, timestampMs);
  }

  assert.equal(chain.height, 100);
  assert.equal(chain.protocolVersionAt(100), 1);
  assert.equal(chain.protocolVersionAt(101), MINING_PROTOCOL_VERSION);
  assert.equal(chain.nextMiningRewardAtoms(), INITIAL_MINING_REWARD_ATOMS);

  const work = {
    chainId: genesis().chainId,
    nonce: 1,
    sender: miner,
    height: 101,
    previousHash: chain.tip.hash,
    rewardAtoms: chain.nextMiningRewardAtoms(),
    workNonce: "0000000000000000",
    publicKey: minerPublic
  };

  let solvedNonce: string | undefined;
  for (let counter = 0; counter < 20_000_000; counter += 1) {
    const workNonce = counter.toString(16).padStart(16, "0");
    const hash = miningWorkHash({ ...work, workNonce });
    if (meetsMiningDifficulty(hash)) {
      solvedNonce = workNonce;
      break;
    }
  }
  assert.ok(solvedNonce, "deterministic integration challenge must solve within bounded search");

  const claim = createMiningClaim({
    chainId: work.chainId,
    nonce: work.nonce,
    sender: miner,
    height: work.height,
    previousHash: work.previousHash,
    rewardAtoms: work.rewardAtoms,
    workNonce: solvedNonce,
    timestampMs: genesis().timestampMs + 101_000
  }, minerPrivate, minerPublic);
  assert.doesNotThrow(() => chain.validateMempoolAdmission(claim));

  const secondClaim = createMiningClaim({
    chainId: work.chainId,
    nonce: 2,
    sender: validator,
    height: work.height,
    previousHash: work.previousHash,
    rewardAtoms: work.rewardAtoms,
    workNonce: "0000000000000000",
    timestampMs: genesis().timestampMs + 101_001
  }, validatorPrivate, validatorPublic);
  assert.throws(
    () => chain.produceBlock([claim, secondClaim], validatorPrivate, { timestampMs: genesis().timestampMs + 101_100 }),
    /more than one mining claim/
  );

  let miningBlock = chain.produceBlock([claim], validatorPrivate, {
    timestampMs: genesis().timestampMs + 101_100
  });
  miningBlock = chain.attestBlock(miningBlock, validatorPrivate);
  chain.acceptBlock(miningBlock, genesis().timestampMs + 101_100);

  assert.equal(chain.height, 101);
  assert.equal(chain.balance(miner), INITIAL_MINING_REWARD_ATOMS);
  assert.equal(chain.miningClaimCount(), 1);
  assert.equal(chain.balance(MINING_TRACKER_ADDRESS), 0);

  const staleClaim = createMiningClaim({
    chainId: work.chainId,
    nonce: 2,
    sender: miner,
    height: 102,
    previousHash: work.previousHash,
    rewardAtoms: chain.nextMiningRewardAtoms(),
    workNonce: solvedNonce,
    timestampMs: genesis().timestampMs + 102_000
  }, minerPrivate, minerPublic);
  assert.throws(() => chain.validateMempoolAdmission(staleClaim), /stale previous hash/);

  const snapshot = chain.snapshot();
  const anchor = {
    tipHash: chain.tip.hash,
    snapshotSha256: sha256Hex(canonicalJson(snapshot))
  };
  const parentDir = await mkdtemp(join(tmpdir(), "zyron-mining-restart-"));
  const dataDir = join(parentDir, "node");
  try {
    await ChainStore.installTrustedSnapshot(genesis(), dataDir, snapshot, anchor);
    const reopened = await ChainStore.open(genesis(), dataDir);
    assert.equal(reopened.chain.height, 101);
    assert.equal(reopened.chain.tip.hash, chain.tip.hash);
    assert.equal(reopened.chain.balance(miner), INITIAL_MINING_REWARD_ATOMS);
    assert.equal(reopened.chain.miningClaimCount(), 1);
    assert.equal(reopened.chain.protocolVersionAt(reopened.chain.height), MINING_PROTOCOL_VERSION);
    assert.equal(reopened.chain.nextMiningRewardAtoms(), chain.nextMiningRewardAtoms());
    assert.throws(() => reopened.chain.validateMempoolAdmission(staleClaim), /stale previous hash/);
  } finally {
    await rm(parentDir, { recursive: true, force: true });
  }
});
