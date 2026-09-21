import assert from "node:assert/strict";
import test from "node:test";

import { MIN_PROTOCOL_UPDATE_DELAY } from "../src/chain.js";
import {
  INITIAL_MINING_REWARD_ATOMS,
  MINING_DIFFICULTY_BITS,
  MINING_ERA_TARGET_CLAIMS,
  MINING_PROTOCOL_VERSION,
  miningRewardAtoms
} from "../src/mining.js";
import { BLOCK_INTERVAL_MS } from "../src/node-base.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "../src/types.js";

test("protocol v5 issuance constants match the consensus implementation", () => {
  assert.equal(ATOMS_PER_ZYN, 100_000_000);
  assert.equal(MAX_SUPPLY_ATOMS, 50_000_000 * ATOMS_PER_ZYN);
  assert.equal(INITIAL_MINING_REWARD_ATOMS, 625_000_000);
  assert.equal(Number.isSafeInteger(INITIAL_MINING_REWARD_ATOMS), true);
  assert.equal(MINING_ERA_TARGET_CLAIMS, 4_000_000);
  assert.equal(MINING_DIFFICULTY_BITS, 20);
  assert.equal(MINING_PROTOCOL_VERSION, 5);
  assert.equal(MIN_PROTOCOL_UPDATE_DELAY, 100);
  assert.equal(BLOCK_INTERVAL_MS, 30_000);
  assert.equal(miningRewardAtoms(0, 0), 625_000_000);
  assert.equal(miningRewardAtoms(4_000_000, 0), 312_500_000);
  assert.equal(miningRewardAtoms(0, MAX_SUPPLY_ATOMS), 0);
});
