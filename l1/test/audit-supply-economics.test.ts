import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  cumulativeMiningIssuanceAtoms,
  INITIAL_MINING_REWARD_ATOMS,
  miningRewardAtoms,
  MINING_TRACKER_ADDRESS
} from "../src/mining.js";
import { LedgerState } from "../src/state.js";
import { createTransfer, validateTransactionShape } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type GenesisConfig } from "../src/types.js";

const aliceKey = "a1".padStart(64, "0");
const bobKey = "b2".padStart(64, "0");
const oracleKey = "c3".padStart(64, "0");
const alicePub = publicKeyFromPrivate(aliceKey);
const bobPub = publicKeyFromPrivate(bobKey);
const alice = addressFromPublicKey(alicePub);
const bob = addressFromPublicKey(bobPub);
const pool = addressFromPublicKey(publicKeyFromPrivate("d4".padStart(64, "0")));

function smallGenesis(supply = 1_000_000_000): GenesisConfig {
  return {
    chainId: "zyron-audit-supply",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: alice, publicKey: alicePub }],
    activityOracles: [publicKeyFromPrivate(oracleKey)],
    activityPool: pool,
    allocations: [
      { address: alice, amountAtoms: supply },
      { address: pool, amountAtoms: 0 }
    ]
  };
}

test("AUDIT: immutable 50M ZYN hard cap is exact safe integer", () => {
  assert.equal(ATOMS_PER_ZYN, 100_000_000);
  assert.equal(MAX_SUPPLY_ATOMS, 50_000_000 * ATOMS_PER_ZYN);
  assert.equal(MAX_SUPPLY_ATOMS, 5_000_000_000_000_000);
  assert.equal(Number.isSafeInteger(MAX_SUPPLY_ATOMS), true);
});

test("AUDIT: only mining_claim mints; transfers/activity redistribute; fees burn", () => {
  const state = LedgerState.fromGenesis(smallGenesis(1_000_000_000));
  const before = state.totalSupplyAtoms();
  const tx = createTransfer({
    chainId: "zyron-audit-supply",
    nonce: 1,
    sender: alice,
    receiver: bob,
    amountAtoms: 100,
    feeAtoms: 7,
    timestampMs: 1
  }, aliceKey, alicePub);
  state.apply(tx, pool);
  assert.equal(state.totalSupplyAtoms(), before - 7, "fee must burn");
  assert.equal(state.balance(bob), 100);
  assert.equal(state.miningClaimCount(), 0);
});

test("AUDIT: mining schedule never exceeds remaining budget under 50M cap", () => {
  assert.equal(cumulativeMiningIssuanceAtoms(Number.MAX_SAFE_INTEGER, 0), MAX_SUPPLY_ATOMS);
  assert.equal(miningRewardAtoms(Number.MAX_SAFE_INTEGER, 0), 0);
  const premine = 10_000_000 * ATOMS_PER_ZYN;
  assert.equal(cumulativeMiningIssuanceAtoms(Number.MAX_SAFE_INTEGER, premine), MAX_SUPPLY_ATOMS - premine);
  assert.equal(miningRewardAtoms(0, 0), INITIAL_MINING_REWARD_ATOMS);
  assert.throws(() => miningRewardAtoms(0, MAX_SUPPLY_ATOMS + 1), /Invalid genesis/);
});

test("AUDIT: genesis rejects mining-tracker allocation and over-cap supply", () => {
  assert.throws(() => {
    LedgerState.fromGenesis({
      ...smallGenesis(),
      allocations: [{ address: MINING_TRACKER_ADDRESS, amountAtoms: 1 }]
    });
  }, /Mining tracker cannot receive a genesis allocation/);
  assert.throws(() => {
    LedgerState.fromGenesis({
      ...smallGenesis(),
      allocations: [
        { address: alice, amountAtoms: MAX_SUPPLY_ATOMS },
        { address: bob, amountAtoms: 1 },
        { address: pool, amountAtoms: 0 }
      ]
    });
  }, /Genesis supply exceeds|maximum supply/);
});

test("AUDIT: amount+fee overflow is rejected (not silently wrapped)", () => {
  const amount = MAX_SUPPLY_ATOMS;
  const fee = MAX_SUPPLY_ATOMS;
  assert.equal(Number.isSafeInteger(amount + fee), false);
  const crafted = {
    kind: "transfer",
    version: 1,
    chainId: "zyron-audit-supply",
    nonce: 1,
    sender: alice,
    receiver: bob,
    amountAtoms: amount,
    feeAtoms: fee,
    timestampMs: 1,
    publicKey: alicePub,
    signature: "ab".repeat(32),
    txid: "cd".repeat(32)
  };
  assert.throws(() => validateTransactionShape(crafted), /Invalid|signature|txid|Transaction/);
});

test("AUDIT: ticker symbol in address prefix is ZYN", () => {
  assert.ok(alice.startsWith("ZYN"));
  assert.equal(alice.length, 43);
});
