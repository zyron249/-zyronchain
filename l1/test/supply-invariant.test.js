import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_MINING_REWARD_ATOMS, MINING_DIFFICULTY_BITS, MINING_ERA_TARGET_CLAIMS, MINING_PROTOCOL_VERSION, MINING_RETIRED, cumulativeMiningIssuanceAtoms, historicalMiningRewardAtoms, miningRewardAtoms } from "../src/mining.js";
import { FIXED_SUPPLY_TOTAL_ZYN, fixedSupplyPlanAtoms } from "../src/tokenomics.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "../src/types.js";
/** IMMUTABLE: total ZYN supply is 50_000_000 forever, fully allocated at genesis. */
const IMMUTABLE_MAX_SUPPLY_ZYN = 50_000_000;
test("MAX_SUPPLY is forever 50_000_000 ZYN at 1e8 atoms", () => {
    assert.equal(ATOMS_PER_ZYN, 100_000_000);
    assert.equal(IMMUTABLE_MAX_SUPPLY_ZYN, 50_000_000);
    assert.equal(FIXED_SUPPLY_TOTAL_ZYN, IMMUTABLE_MAX_SUPPLY_ZYN);
    assert.equal(MAX_SUPPLY_ATOMS, IMMUTABLE_MAX_SUPPLY_ZYN * ATOMS_PER_ZYN);
    assert.equal(MAX_SUPPLY_ATOMS, 5_000_000_000_000_000);
    assert.equal(Number.isSafeInteger(MAX_SUPPLY_ATOMS), true);
});
test("the fixed-supply plan allocates exactly the 50M cap at genesis (10/40/40/10)", () => {
    const plan = fixedSupplyPlanAtoms();
    const parts = Object.entries(plan).filter(([name]) => name !== "total").map(([, value]) => value);
    assert.equal(parts.reduce((total, value) => total + value, 0), MAX_SUPPLY_ATOMS);
});
test("mining is retired: no issuance schedule can add supply on top of the genesis allocation", () => {
    assert.equal(MINING_RETIRED, true);
    // Historical constants are kept only to decode and reject old claim encodings.
    assert.equal(MINING_PROTOCOL_VERSION, 5);
    assert.equal(INITIAL_MINING_REWARD_ATOMS, 625_000_000);
    assert.equal(MINING_ERA_TARGET_CLAIMS, 4_000_000);
    assert.equal(MINING_DIFFICULTY_BITS, 20);
    for (const premine of [0, 10_000_000 * ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS]) {
        assert.equal(miningRewardAtoms(0, premine), 0);
        assert.equal(miningRewardAtoms(Number.MAX_SAFE_INTEGER, premine), 0);
    }
    // Even the historical schedule saturates at the cap and never exceeds it.
    assert.equal(cumulativeMiningIssuanceAtoms(Number.MAX_SAFE_INTEGER, 0), MAX_SUPPLY_ATOMS);
    assert.equal(historicalMiningRewardAtoms(0, MAX_SUPPLY_ATOMS), 0);
    assert.throws(() => miningRewardAtoms(0, MAX_SUPPLY_ATOMS + 1), /Invalid genesis ZYN supply/);
});
test("halving eras are rejected: the reward is zero in every era (formerly 6.25 ZYN halving every 4M claims)", () => {
    // Was: era 0 paid 6.25 ZYN and era 1 paid 3.125 ZYN. Mining is retired, so
    // every era now pays nothing; only the reference schedule keeps the old values.
    for (const era of [0, 1, 2, 10]) {
        assert.equal(miningRewardAtoms(MINING_ERA_TARGET_CLAIMS * era, 0), 0);
    }
    assert.equal(historicalMiningRewardAtoms(0, 0), INITIAL_MINING_REWARD_ATOMS);
    assert.equal(historicalMiningRewardAtoms(MINING_ERA_TARGET_CLAIMS, 0), INITIAL_MINING_REWARD_ATOMS / 2);
});
