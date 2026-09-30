import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { assertMiningClaimContext, historicalMiningRewardAtoms, miningRewardAtoms } from "../src/mining.js";
import {
  buildFixedSupplyAllocations,
  ECOSYSTEM_RESERVE_ATOMS,
  FIXED_SUPPLY_TOTAL_ZYN,
  FOUNDER_ALLOCATION_ATOMS,
  LIQUIDITY_RESERVE_ATOMS,
  PUBLIC_DISTRIBUTION_ATOMS
} from "../src/tokenomics.js";
import { createMiningClaim } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type GenesisConfig } from "../src/types.js";

const founderPrivate = "31".padStart(64, "0");
const publicPrivate = "32".padStart(64, "0");
const liquidityPrivate = "33".padStart(64, "0");
const ecosystemPrivate = "34".padStart(64, "0");
const validatorPrivate = "35".padStart(64, "0");
const oraclePrivate = "36".padStart(64, "0");

function address(privateKey: string) {
  return addressFromPublicKey(publicKeyFromPrivate(privateKey));
}

const roles = {
  founder: address(founderPrivate),
  publicDistribution: address(publicPrivate),
  liquidityReserve: address(liquidityPrivate),
  ecosystemReserve: address(ecosystemPrivate)
};

test("fixed-supply plan is exactly 50M ZYN with a 10/40/40/10 split", () => {
  assert.equal(FOUNDER_ALLOCATION_ATOMS, 5_000_000 * ATOMS_PER_ZYN);
  assert.equal(PUBLIC_DISTRIBUTION_ATOMS, 20_000_000 * ATOMS_PER_ZYN);
  assert.equal(LIQUIDITY_RESERVE_ATOMS, 20_000_000 * ATOMS_PER_ZYN);
  assert.equal(ECOSYSTEM_RESERVE_ATOMS, 5_000_000 * ATOMS_PER_ZYN);
  assert.equal(
    FOUNDER_ALLOCATION_ATOMS + PUBLIC_DISTRIBUTION_ATOMS + LIQUIDITY_RESERVE_ATOMS + ECOSYSTEM_RESERVE_ATOMS,
    MAX_SUPPLY_ATOMS
  );
  assert.equal(FIXED_SUPPLY_TOTAL_ZYN, 50_000_000);
});

test("fixed-supply allocation builder emits four distinct disclosed genesis accounts", () => {
  const allocations = buildFixedSupplyAllocations(roles);
  assert.equal(allocations.length, 4);
  assert.equal(new Set(allocations.map((item) => item.address)).size, 4);
  assert.equal(allocations.reduce((sum, item) => sum + item.amountAtoms, 0), MAX_SUPPLY_ATOMS);
});

test("duplicate fixed-supply role addresses fail closed", () => {
  assert.throws(
    () => buildFixedSupplyAllocations({ ...roles, ecosystemReserve: roles.founder }),
    /distinct addresses/
  );
});

// Owner decision 2026-09-30: mining is retired for every genesis. The claim is
// now rejected by the retirement guard; the historical schedule would also have
// been exhausted by a full 50M genesis.
test("a full 50M genesis mints nothing: mining is retired and the historical schedule is exhausted", () => {
  assert.equal(miningRewardAtoms(0, MAX_SUPPLY_ATOMS), 0);
  assert.equal(historicalMiningRewardAtoms(0, MAX_SUPPLY_ATOMS), 0);

  const minerPublic = publicKeyFromPrivate(founderPrivate);
  const claim = createMiningClaim({
    chainId: "zyron-fixed-supply-test",
    nonce: 1,
    sender: roles.founder,
    height: 1,
    previousHash: "ab".repeat(32),
    rewardAtoms: 1,
    workNonce: "0000000000000000",
    timestampMs: 1_700_000_000_001
  }, founderPrivate, minerPublic);

  assert.throws(
    () => assertMiningClaimContext(claim, {
      nextHeight: 1,
      previousHash: claim.previousHash,
      claimCount: 0,
      genesisSupplyAtoms: MAX_SUPPLY_ATOMS
    }),
    /Mining is retired/
  );
});

test("fixed-supply allocations can be embedded in an otherwise ordinary genesis config", () => {
  const validatorPublic = publicKeyFromPrivate(validatorPrivate);
  const oraclePublic = publicKeyFromPrivate(oraclePrivate);
  const genesis: GenesisConfig = {
    chainId: "zyron-fixed-supply-test",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: address(validatorPrivate), publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool: roles.ecosystemReserve,
    allocations: buildFixedSupplyAllocations(roles)
  };
  assert.equal(genesis.allocations.reduce((sum, item) => sum + item.amountAtoms, 0), MAX_SUPPLY_ATOMS);
});

test("CRYPTO-REVIEW ZC-CRY-20260930-006: activity pool must be exactly the ecosystem/community allocation", async () => {
  const { assertFixedSupplyGenesis } = await import("../src/tokenomics.js");
  const validatorPublic = publicKeyFromPrivate(validatorPrivate);
  const oraclePublic = publicKeyFromPrivate(oraclePrivate);
  const base = (activityPool: GenesisConfig["activityPool"]): GenesisConfig => ({
    chainId: "zyron-fixed-supply-test",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: address(validatorPrivate), publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: buildFixedSupplyAllocations(roles)
  });
  const forbidden = /must not be the founder, public-distribution, or permanent-liquidity/;
  assert.throws(() => assertFixedSupplyGenesis(base(roles.founder), roles), forbidden);
  assert.throws(() => assertFixedSupplyGenesis(base(roles.publicDistribution), roles), forbidden);
  assert.throws(() => assertFixedSupplyGenesis(base(roles.liquidityReserve), roles), forbidden);
  assert.throws(() => assertFixedSupplyGenesis(base(address(oraclePrivate)), roles), /must be the ecosystem\/community allocation/);
  assert.doesNotThrow(() => assertFixedSupplyGenesis(base(roles.ecosystemReserve), roles));
});
