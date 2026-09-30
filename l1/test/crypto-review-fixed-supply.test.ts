import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ZyronChain } from "../src/chain.js";
import {
  MINING_PROTOCOL_VERSION,
  assertMiningClaimContext,
  cumulativeMiningIssuanceAtoms,
  meetsMiningDifficulty,
  miningRewardAtoms,
  miningWorkHash
} from "../src/mining.js";
import { LedgerState } from "../src/state.js";
import { ChainStore } from "../src/storage.js";
import {
  createMiningClaim,
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer
} from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type Address, type GenesisConfig, type MiningClaimTx } from "../src/types.js";

/**
 * ZC-CRY-20260930-002 / -003. Independent check of the owner's authoritative
 * tokenomics spec (50M ZYN, all at genesis, 10/40/40/10) against the L1 mint
 * paths. Constants are restated here on purpose instead of imported from the
 * draft #913 module so that a drift in either place is caught.
 */

const SPEC = {
  founder: 5_000_000n,
  publicDistribution: 20_000_000n,
  liquidityReserve: 20_000_000n,
  ecosystemReserve: 5_000_000n
} as const;
const ATOMS = BigInt(ATOMS_PER_ZYN);

const validatorPrivate = "31".padStart(64, "0");
const oraclePrivate = "32".padStart(64, "0");
const minerPrivate = "33".padStart(64, "0");
const rolePrivate = {
  founder: "41".padStart(64, "0"),
  publicDistribution: "42".padStart(64, "0"),
  liquidityReserve: "43".padStart(64, "0"),
  ecosystemReserve: "44".padStart(64, "0")
} as const;
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validator = addressFromPublicKey(validatorPublic);
const minerPublic = publicKeyFromPrivate(minerPrivate);
const miner = addressFromPublicKey(minerPublic);
const rolePublic = Object.fromEntries(Object.entries(rolePrivate).map(([k, v]) => [k, publicKeyFromPrivate(v)])) as Record<keyof typeof SPEC, string>;
const roleAddress = Object.fromEntries(Object.entries(rolePublic).map(([k, v]) => [k, addressFromPublicKey(v)])) as Record<keyof typeof SPEC, Address>;

function fixedSupplyGenesis(overrideFounderAtoms?: number): GenesisConfig {
  return {
    chainId: "zyron-fixed-supply-review-1",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validator, publicKey: validatorPublic }],
    activityOracles: [publicKeyFromPrivate(oraclePrivate)],
    activityPool: roleAddress.publicDistribution,
    allocations: (Object.keys(SPEC) as Array<keyof typeof SPEC>).map((role) => ({
      address: roleAddress[role],
      amountAtoms: role === "founder" && overrideFounderAtoms !== undefined
        ? overrideFounderAtoms
        : Number(SPEC[role] * ATOMS)
    }))
  };
}

test("CRYPTO-REVIEW: spec allocation is atom-exact 10/40/40/10 and sums to MAX_SUPPLY_ATOMS", () => {
  const total = Object.values(SPEC).reduce((sum, value) => sum + value * ATOMS, 0n);
  assert.equal(total, 5_000_000_000_000_000n);
  assert.equal(BigInt(MAX_SUPPLY_ATOMS), total);
  assert.equal(SPEC.founder * ATOMS * 10n, total);
  assert.equal(SPEC.publicDistribution * ATOMS * 10n, total * 4n);
  assert.equal(SPEC.liquidityReserve * ATOMS * 10n, total * 4n);
  assert.equal(SPEC.ecosystemReserve * ATOMS * 10n, total);
  assert.ok(Number.isSafeInteger(MAX_SUPPLY_ATOMS));
  for (const allocation of fixedSupplyGenesis().allocations) assert.ok(Number.isSafeInteger(allocation.amountAtoms));
  const chain = new ZyronChain(fixedSupplyGenesis());
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
  assert.equal(LedgerState.fromGenesis(fixedSupplyGenesis()).totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
});

test("CRYPTO-REVIEW: one atom above the cap is rejected at genesis", () => {
  assert.throws(() => new ZyronChain(fixedSupplyGenesis(Number(SPEC.founder * ATOMS) + 1)), /exceeds maximum supply/);
});

test("CRYPTO-REVIEW: full-cap genesis makes the reward schedule zero for every claim count", () => {
  for (const count of [0, 1, 3_999_999, 4_000_000, 64_000_000, Number.MAX_SAFE_INTEGER - 1]) {
    assert.equal(miningRewardAtoms(count, MAX_SUPPLY_ATOMS), 0, `claimCount=${count}`);
    assert.equal(cumulativeMiningIssuanceAtoms(count, MAX_SUPPLY_ATOMS), 0, `claimCount=${count}`);
  }
});

test("CRYPTO-REVIEW: off-by-one boundary — MAX-1 genesis admits exactly one atom and then nothing", () => {
  assert.equal(miningRewardAtoms(0, MAX_SUPPLY_ATOMS - 1), 1);
  assert.equal(cumulativeMiningIssuanceAtoms(1, MAX_SUPPLY_ATOMS - 1), 1);
  assert.equal(miningRewardAtoms(1, MAX_SUPPLY_ATOMS - 1), 0);
  const claim = createMiningClaim({
    chainId: "x-chain", nonce: 1, sender: miner, height: 5, previousHash: "ab".repeat(32),
    rewardAtoms: 2, workNonce: "0000000000000000", timestampMs: 1
  }, minerPrivate, minerPublic);
  assert.throws(() => assertMiningClaimContext(claim, {
    nextHeight: 5, previousHash: "ab".repeat(32), claimCount: 0, genesisSupplyAtoms: MAX_SUPPLY_ATOMS - 1
  }), /reward does not match/);
});

test("CRYPTO-REVIEW: explicit fail-closed mining retirement fires before schedule and PoW checks", () => {
  const claim = createMiningClaim({
    chainId: "x-chain", nonce: 1, sender: miner, height: 5, previousHash: "ab".repeat(32),
    rewardAtoms: 1, workNonce: "0000000000000000", timestampMs: 1
  }, minerPrivate, minerPublic);
  assert.throws(() => assertMiningClaimContext(claim, {
    nextHeight: 5, previousHash: "ab".repeat(32), claimCount: 0, genesisSupplyAtoms: MAX_SUPPLY_ATOMS
  }), /Mining is retired/);
});

test("CRYPTO-REVIEW: legacy ledger refuses a 1-atom mint at full supply", () => {
  const ledger = LedgerState.fromGenesis(fixedSupplyGenesis());
  const claim = createMiningClaim({
    chainId: "x-chain", nonce: 1, sender: miner, height: 5, previousHash: "ab".repeat(32),
    rewardAtoms: 1, workNonce: "0000000000000000", timestampMs: 1
  }, minerPrivate, minerPublic);
  assert.throws(() => ledger.apply(claim, roleAddress.publicDistribution), /exceeds maximum supply/);
  assert.equal(ledger.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
});

function solve(work: Parameters<typeof miningWorkHash>[0]): string {
  for (let counter = 0; counter < 20_000_000; counter += 1) {
    const workNonce = counter.toString(16).padStart(16, "0");
    if (meetsMiningDifficulty(miningWorkHash({ ...work, workNonce }))) return workNonce;
  }
  throw new Error("unsolved");
}

test("CRYPTO-REVIEW: protocol-v5 fixed-supply chain rejects a PoW-valid 1-atom claim on every path, after fee burns and restart", { timeout: 180_000 }, async () => {
  const genesis = fixedSupplyGenesis();
  const chain = new ZyronChain(genesis);
  const upgradeInput = { chainId: genesis.chainId, nonce: 1, sender: validator, activationHeight: 101, protocolVersion: MINING_PROTOCOL_VERSION };
  const upgrade = createProtocolUpgrade({
    ...upgradeInput,
    approvals: [createProtocolUpgradeApproval(upgradeInput, validatorPrivate, validatorPublic)],
    timestampMs: genesis.timestampMs + 10
  }, validatorPrivate, validatorPublic);
  for (let height = 1; height <= 100; height += 1) {
    const timestampMs = genesis.timestampMs + height * 1_000;
    let block = chain.produceBlock(height === 1 ? [upgrade] : [], validatorPrivate, { timestampMs });
    block = chain.attestBlock(block, validatorPrivate);
    chain.acceptBlock(block, timestampMs);
  }
  assert.equal(chain.protocolVersionAt(101), MINING_PROTOCOL_VERSION);
  assert.equal(chain.nextMiningRewardAtoms(), 0);

  const makeClaim = (): MiningClaimTx => {
    const work = {
      chainId: genesis.chainId, nonce: 1, sender: miner, height: chain.height + 1,
      previousHash: chain.tip.hash, rewardAtoms: 1, workNonce: "0000000000000000", publicKey: minerPublic
    };
    return createMiningClaim({ ...work, workNonce: solve(work), timestampMs: genesis.timestampMs + (chain.height + 1) * 1_000 }, minerPrivate, minerPublic);
  };
  const claim = makeClaim();
  assert.ok(meetsMiningDifficulty(miningWorkHash(claim)), "claim carries real PoW");
  assert.throws(() => chain.validateMempoolAdmission(claim), /Mining is retired/);
  assert.deepEqual(chain.selectValidPending([claim], 10), []);
  assert.throws(() => chain.produceBlock([claim], validatorPrivate, { timestampMs: genesis.timestampMs + 101_000 }), /Mining is retired/);
  assert.throws(() => chain.validatePending([claim]), /Mining is retired/);

  // Fee burn lowers circulating supply but must not reopen issuance headroom.
  const burn = createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: roleAddress.ecosystemReserve, receiver: miner,
    amountAtoms: 1, feeAtoms: 1_000_000, timestampMs: genesis.timestampMs + 101_000
  }, rolePrivate.ecosystemReserve, rolePublic.ecosystemReserve, 2);
  let block = chain.produceBlock([burn], validatorPrivate, { timestampMs: genesis.timestampMs + 101_000 });
  block = chain.attestBlock(block, validatorPrivate);
  chain.acceptBlock(block, genesis.timestampMs + 101_000);
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS - 1_000_000);
  assert.equal(chain.nextMiningRewardAtoms(), 0);
  const afterBurn = makeClaim();
  assert.throws(() => chain.validateMempoolAdmission(afterBurn), /Mining is retired/);

  const snapshot = chain.snapshot();
  const anchor = { tipHash: chain.tip.hash, snapshotSha256: sha256Hex(canonicalJson(snapshot)) };
  const parentDir = await mkdtemp(join(tmpdir(), "zyron-fixed-supply-restart-"));
  try {
    const dataDir = join(parentDir, "node");
    await ChainStore.installTrustedSnapshot(genesis, dataDir, snapshot, anchor);
    const reopened = await ChainStore.open(genesis, dataDir);
    assert.equal(reopened.chain.genesisSupplyAtoms(), MAX_SUPPLY_ATOMS);
    assert.equal(reopened.chain.nextMiningRewardAtoms(), 0);
    assert.throws(() => reopened.chain.validateMempoolAdmission(afterBurn), /Mining is retired/);
    assert.deepEqual(reopened.chain.selectValidPending([afterBurn], 10), []);
  } finally {
    await rm(parentDir, { recursive: true, force: true });
  }
});
