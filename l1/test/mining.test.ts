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
  MINING_RETIRED,
  MINING_TRACKER_ADDRESS,
  assertMiningClaimContext,
  cumulativeMiningIssuanceAtoms,
  historicalMiningRewardAtoms,
  meetsMiningDifficulty,
  miningEraForClaimCount,
  miningRewardAtoms,
  miningWorkHash
} from "../src/mining.js";
import { createBlockAttestation, createSignedBlock } from "../src/block.js";
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

// RETIRED (owner decision 2026-09-30): mining is shut down for every genesis.
// Tests in this file that previously proved claims were admitted/minted now
// prove the same claims are rejected by consensus on every path. Pure helper
// characterizations (work binding, difficulty, historical schedule) are kept.
const RETIRED = /Mining is retired/;

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

test("mining is retired: next reward is always zero; the historical 6.25 ZYN halving schedule is kept only for reference", () => {
  assert.equal(MINING_RETIRED, true);
  assert.equal(INITIAL_MINING_REWARD_ATOMS, 6.25 * ATOMS_PER_ZYN);
  assert.equal(MINING_ERA_TARGET_CLAIMS, 4_000_000);
  assert.equal(MINING_PROTOCOL_VERSION, 5);
  assert.equal(miningEraForClaimCount(0), 0);
  assert.equal(miningEraForClaimCount(3_999_999), 0);
  assert.equal(miningEraForClaimCount(4_000_000), 1);
  for (const claims of [0, 1, 4_000_000, 8_000_000]) {
    assert.equal(miningRewardAtoms(claims, 0), 0);
  }
  assert.equal(historicalMiningRewardAtoms(0, 0), 625_000_000);
  assert.equal(historicalMiningRewardAtoms(4_000_000, 0), 312_500_000);
  assert.equal(historicalMiningRewardAtoms(8_000_000, 0), 156_250_000);
  assert.equal(cumulativeMiningIssuanceAtoms(4_000_000, 0), 25_000_000 * ATOMS_PER_ZYN);
  assert.equal(cumulativeMiningIssuanceAtoms(8_000_000, 0), 37_500_000 * ATOMS_PER_ZYN);
  assert.throws(() => miningRewardAtoms(-1, 0), /Invalid finalized mining claim count/);
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

test("mining claim shape validation rejects every claim as retired, including malformed ones", () => {
  const claim = createMiningClaim(unsignedContext(), minerPrivate, minerPublic);
  assert.equal(claim.kind, "mining_claim");
  assert.equal(claim.version, 2);
  assert.equal(claim.feeAtoms, 0);
  assert.throws(() => validateTransactionShape(claim), RETIRED);
  assert.throws(() => validateTransactionShape({ ...claim, workNonce: "xyz" }), RETIRED);
  assert.throws(() => validateTransactionShape({ ...claim, rewardAtoms: 0 }), RETIRED);
  // Extra keys still fail the exact-key check first.
  assert.throws(() => validateTransactionShape({ ...claim, extra: 1 }), /mining claim/);
});

test("mining claims are rejected by mempool admission under protocol v1 (mining retired)", () => {
  const chain = new ZyronChain(genesis());
  const claim = createMiningClaim(unsignedContext({ previousHash: chain.tip.hash }), minerPrivate, minerPublic);
  assert.throws(() => chain.validateMempoolAdmission(claim), RETIRED);
});

test("mempool admits zero mining claims: the former 256-entry mining subpool is never occupied", () => {
  const mempool = new Mempool();
  for (let index = 0; index <= MAX_MINING_MEMPOOL_CLAIMS; index += 1) {
    assert.throws(() => mempool.add(policyMiningClaim(index, index === MAX_MINING_MEMPOOL_CLAIMS ? 2 : 1)), RETIRED);
  }
  assert.equal(mempool.size, 0);
});

test("same proof with a new timestamp/txid is rejected as retired, not treated as a nonce conflict", () => {
  const mempool = new Mempool();
  const first = createMiningClaim(unsignedContext({ timestampMs: genesis().timestampMs + 10 }), minerPrivate, minerPublic);
  const replay = createMiningClaim(unsignedContext({ timestampMs: genesis().timestampMs + 20 }), minerPrivate, minerPublic);
  assert.equal(miningWorkHash(first), miningWorkHash(replay));
  assert.notEqual(first.txid, replay.txid);
  assert.throws(() => mempool.add(first), RETIRED);
  assert.throws(() => mempool.add(replay), RETIRED);
  assert.equal(mempool.size, 0);
});

test("mining traffic cannot evict a normal transfer from an otherwise full mempool (claims rejected as retired)", () => {
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

  assert.throws(() => mempool.add(policyMiningClaim(10)), RETIRED);
  assert.equal(mempool.size, 1);
  assert.equal(mempool.values()[0]?.txid, transfer.txid);
});

test("legacy ledger refuses to apply a mining claim: no credit, no nonce, no counter advance (mining retired)", () => {
  const state = LedgerState.fromGenesis(genesis());
  const claim = createMiningClaim(unsignedContext(), minerPrivate, minerPublic);
  assert.throws(() => state.apply(claim, pool), RETIRED);
  assert.equal(state.balance(miner), 0);
  assert.equal(state.nonce(miner), 0);
  assert.equal(state.balance(MINING_TRACKER_ADDRESS), 0);
  assert.equal(state.miningClaimCount(), 0);
  assert.equal(state.totalSupplyAtoms(), 0);
});

test("State-v2 applier refuses mining claims as retired (semantic key derivation unchanged)", () => {
  const claim = createMiningClaim(unsignedContext(), minerPrivate, minerPublic);
  const keys = stateV2TransactionKeyPreimages(claim);
  assert.deepEqual(keys, [
    `account:${MINING_TRACKER_ADDRESS}`,
    `account:${miner}`
  ].sort());
  assert.throws(() => applyStateV2Transaction(SparseMerkleState.empty(), claim, pool), RETIRED);
  assert.throws(() => assertMiningClaimContext(claim, {
    nextHeight: 1,
    previousHash: claim.previousHash,
    claimCount: 0,
    genesisSupplyAtoms: 0
  }), RETIRED);
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
  // Retirement is checked first; the claim is refused either way.
  assert.throws(() => state.apply(forgedTracker, pool), RETIRED);
  assert.throws(() => validateTransactionShape(forgedTracker), /protocol-reserved|Mining is retired/);
  assert.equal(state.miningClaimCount(), 0);
});

test("protocol v5 activates but a real proof-of-work claim is rejected on every consensus path and after trusted-snapshot restart", { timeout: 120_000 }, async () => {
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
  assert.equal(chain.nextMiningRewardAtoms(), 0);

  // Solve a genuine 20-bit proof at the historical reward so the rejection
  // cannot be blamed on bad work, a stale tip, or a wrong nonce.
  const work = {
    chainId: genesis().chainId,
    nonce: 1,
    sender: miner,
    height: 101,
    previousHash: chain.tip.hash,
    rewardAtoms: historicalMiningRewardAtoms(chain.miningClaimCount(), 0),
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
  const blockTime = genesis().timestampMs + 101_100;

  assert.throws(() => chain.validateMempoolAdmission(claim), RETIRED);
  assert.throws(() => chain.validatePending([claim]), RETIRED);
  assert.deepEqual(chain.selectValidPending([claim], 10), []);
  assert.throws(() => chain.produceBlock([claim], validatorPrivate, { timestampMs: blockTime }), RETIRED);

  // A validator-signed, fully attested block that smuggles the claim in is
  // refused at shape validation before any state transition.
  const smuggled = createSignedBlock({
    version: MINING_PROTOCOL_VERSION,
    chainId: genesis().chainId,
    height: 101,
    round: 0,
    previousHash: chain.tip.hash,
    timestampMs: blockTime,
    transactions: [claim],
    stateRoot: "00".repeat(32),
    proposerPrivateKey: validatorPrivate,
    proposerPublicKey: validatorPublic
  });
  smuggled.attestations.push(createBlockAttestation(smuggled, validatorPrivate, validatorPublic));
  assert.throws(() => chain.acceptBlock(smuggled, blockTime), RETIRED);
  assert.throws(() => chain.validateProposal({ ...smuggled, attestations: [] }, blockTime), RETIRED);

  // Ordinary blocks keep finalizing under protocol v5.
  let emptyBlock = chain.produceBlock([], validatorPrivate, { timestampMs: blockTime });
  emptyBlock = chain.attestBlock(emptyBlock, validatorPrivate);
  chain.acceptBlock(emptyBlock, blockTime);
  assert.equal(chain.height, 101);
  assert.equal(chain.balance(miner), 0);
  assert.equal(chain.miningClaimCount(), 0);
  assert.equal(chain.balance(MINING_TRACKER_ADDRESS), 0);

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
    assert.equal(reopened.chain.balance(miner), 0);
    assert.equal(reopened.chain.miningClaimCount(), 0);
    assert.equal(reopened.chain.protocolVersionAt(reopened.chain.height), MINING_PROTOCOL_VERSION);
    assert.equal(reopened.chain.nextMiningRewardAtoms(), 0);
    const nextClaim = { ...claim, height: 102, previousHash: reopened.chain.tip.hash };
    assert.throws(() => reopened.chain.validateMempoolAdmission(nextClaim), RETIRED);
  } finally {
    await rm(parentDir, { recursive: true, force: true });
  }
});
