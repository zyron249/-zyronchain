import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { assertMiningClaimContext, miningRewardAtoms } from "../src/mining.js";
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

test("a full 50M genesis exhausts mining issuance permanently", () => {
  assert.equal(miningRewardAtoms(0, MAX_SUPPLY_ATOMS), 0);

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
    /maximum historical issuance has been reached/
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
