import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_MINING_REWARD_ATOMS,
  MINING_DIFFICULTY_BITS,
  MINING_ERA_TARGET_CLAIMS,
  MINING_PROTOCOL_VERSION,
  cumulativeMiningIssuanceAtoms,
  miningRewardAtoms
} from "../src/mining.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "../src/types.js";

/** IMMUTABLE: historical ZYN issuance cap is 50_000_000 forever. */
const IMMUTABLE_MAX_SUPPLY_ZYN = 50_000_000;

test("MAX_SUPPLY is forever 50_000_000 ZYN at 1e8 atoms", () => {
  assert.equal(ATOMS_PER_ZYN, 100_000_000);
  assert.equal(IMMUTABLE_MAX_SUPPLY_ZYN, 50_000_000);
  assert.equal(MAX_SUPPLY_ATOMS, IMMUTABLE_MAX_SUPPLY_ZYN * ATOMS_PER_ZYN);
  assert.equal(MAX_SUPPLY_ATOMS, 5_000_000_000_000_000);
  assert.equal(Number.isSafeInteger(MAX_SUPPLY_ATOMS), true);
});

test("protocol v5 issuance schedule never exceeds the immutable 50M cap", () => {
  assert.equal(MINING_PROTOCOL_VERSION, 5);
  assert.equal(INITIAL_MINING_REWARD_ATOMS, 625_000_000);
  assert.equal(MINING_ERA_TARGET_CLAIMS, 4_000_000);
  assert.equal(MINING_DIFFICULTY_BITS, 20);

  // Zero premine: full schedule saturates exactly at the cap and then pays zero.
  const zeroPremineIssued = cumulativeMiningIssuanceAtoms(Number.MAX_SAFE_INTEGER, 0);
  assert.equal(zeroPremineIssued, MAX_SUPPLY_ATOMS);
  assert.equal(miningRewardAtoms(Number.MAX_SAFE_INTEGER, 0), 0);

  // 10M premine: mining budget is the remaining 40M and never reopens burned supply.
  const premine = 10_000_000 * ATOMS_PER_ZYN;
  const withPremine = cumulativeMiningIssuanceAtoms(Number.MAX_SAFE_INTEGER, premine);
  assert.equal(withPremine, MAX_SUPPLY_ATOMS - premine);
  assert.equal(miningRewardAtoms(Number.MAX_SAFE_INTEGER, premine), 0);

  assert.throws(() => miningRewardAtoms(0, MAX_SUPPLY_ATOMS + 1), /Invalid genesis ZYN supply/);
});

test("halving eras stay inside the 50M atom budget", () => {
  const era0 = cumulativeMiningIssuanceAtoms(MINING_ERA_TARGET_CLAIMS, 0);
  const era1 = cumulativeMiningIssuanceAtoms(MINING_ERA_TARGET_CLAIMS * 2, 0);
  assert.equal(era0, 25_000_000 * ATOMS_PER_ZYN);
  assert.equal(era1, 37_500_000 * ATOMS_PER_ZYN);
  assert.ok(era0 < MAX_SUPPLY_ATOMS);
  assert.ok(era1 < MAX_SUPPLY_ATOMS);
  assert.equal(miningRewardAtoms(0, 0), INITIAL_MINING_REWARD_ATOMS);
  assert.equal(miningRewardAtoms(MINING_ERA_TARGET_CLAIMS, 0), INITIAL_MINING_REWARD_ATOMS / 2);
});
