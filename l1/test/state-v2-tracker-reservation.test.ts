// D62-I1 (Info, defence in depth): the raw State-v2 applier
// `applyStateV2Transaction` must keep MINING_TRACKER_ADDRESS protocol-reserved
// exactly like the legacy LedgerState applier does: a transfer may not credit
// or debit the tracker, an activity settlement may not credit it, and the
// tracker may not send a validator update or a protocol upgrade.
//
// Not reachable through the chain today: both chain callers run
// `validateTransactionShape` first, which already rejects every case below
// with the same message. These tests pin the raw applier itself so a later
// refactor of the chain path cannot silently drop the reservation.
import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { MINING_TRACKER_ADDRESS } from "../src/mining.js";
import { LedgerState } from "../src/state.js";
import {
  applyStateV2Transaction,
  stateV2Balance,
  stateV2FromLedgerSnapshot,
  stateV2Nonce,
  type SparseMerkleState
} from "../src/state-v2.js";
import {
  createActivitySettlement,
  createProtocolUpgrade,
  createTransfer,
  createValidatorSetUpdate
} from "../src/transaction.js";
import { ATOMS_PER_ZYN, type Address, type GenesisConfig, type Transaction } from "../src/types.js";

const TRACKER_RESERVED = "Mining tracker address is protocol-reserved";

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 81;
const ORACLE = 82;
const POOL = 83;
const ALICE = 84;
const BOB = 85;
const CHAIN_ID = "zyron-d62-i1-statev2-tracker";
const T0 = 1_700_000_000_000;

function genesis(): GenesisConfig {
  return {
    chainId: CHAIN_ID,
    timestampMs: T0,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(POOL),
    allocations: [
      { address: addr(POOL), amountAtoms: 1_000 * ATOMS_PER_ZYN },
      { address: addr(ALICE), amountAtoms: 1_000 * ATOMS_PER_ZYN }
    ]
  };
}

function freshStateV2(config: GenesisConfig): SparseMerkleState {
  return stateV2FromLedgerSnapshot(LedgerState.fromGenesis(config).snapshot());
}

/** Assert that `fn` throws an Error whose message is exactly `message`. */
function throwsExactly(fn: () => unknown, message: string, label: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, `${label}: expected an Error to be thrown`);
  assert.equal(thrown.message, message, `${label}: unexpected rejection message`);
}

/**
 * The raw State-v2 applier and the legacy applier reject `tx` with the exact
 * reserved-tracker message, and the State-v2 input state is left untouched.
 */
function assertBothAppliersReserveTracker(config: GenesisConfig, tx: Transaction, label: string): void {
  const state = freshStateV2(config);
  const rootBefore = state.root();
  throwsExactly(() => applyStateV2Transaction(state, tx, config.activityPool), TRACKER_RESERVED, `${label} (State-v2 applier)`);
  throwsExactly(
    () => applyStateV2Transaction(state, tx, config.activityPool, undefined, config),
    TRACKER_RESERVED,
    `${label} (State-v2 applier with genesis oracle set)`
  );
  assert.equal(state.root(), rootBefore, `${label}: State-v2 input state must not change`);
  assert.equal(stateV2Balance(state, MINING_TRACKER_ADDRESS), 0, `${label}: tracker balance`);
  assert.equal(stateV2Nonce(state, MINING_TRACKER_ADDRESS), 0, `${label}: tracker nonce (claim counter)`);
  throwsExactly(
    () => LedgerState.fromGenesis(config).apply(tx, config.activityPool),
    TRACKER_RESERVED,
    `${label} (legacy applier, parity)`
  );
}

function transfer(sender: Address, receiver: Address, signer: number): Transaction {
  return createTransfer({
    chainId: CHAIN_ID,
    nonce: 1,
    sender,
    receiver,
    amountAtoms: 1,
    feeAtoms: 0,
    timestampMs: T0 + 1
  }, key(signer), pub(signer));
}

function settlement(config: GenesisConfig, receivers: Address[]): Transaction {
  return createActivitySettlement({
    chainId: CHAIN_ID,
    nonce: 1,
    sender: config.activityPool,
    epoch: 0,
    entries: receivers.map((receiver) => ({ receiver, amountAtoms: 1 })),
    receiptRoot: "00".repeat(32),
    timestampMs: T0 + 1
  }, key(ORACLE), pub(ORACLE));
}

test("D62-I1: State-v2 applier rejects a transfer that credits the mining tracker", () => {
  const config = genesis();
  assertBothAppliersReserveTracker(config, transfer(addr(ALICE), MINING_TRACKER_ADDRESS, ALICE), "transfer receiver");
});

test("D62-I1: State-v2 applier rejects a transfer sent from the mining tracker", () => {
  const config = genesis();
  // The tracker holds no key and no balance; the reservation must win over the
  // nonce and balance checks, exactly like the legacy applier.
  assertBothAppliersReserveTracker(config, transfer(MINING_TRACKER_ADDRESS, addr(BOB), ALICE), "transfer sender");
});

test("D62-I1: State-v2 applier rejects an activity settlement that credits the mining tracker", () => {
  const config = genesis();
  assertBothAppliersReserveTracker(config, settlement(config, [MINING_TRACKER_ADDRESS]), "settlement single entry");
  assertBothAppliersReserveTracker(
    config,
    settlement(config, [addr(BOB), MINING_TRACKER_ADDRESS]),
    "settlement tracker as second entry"
  );
});

test("D62-I1: State-v2 applier rejects a validator update or protocol upgrade sent from the mining tracker", () => {
  const config = genesis();
  const validatorUpdate = createValidatorSetUpdate({
    chainId: CHAIN_ID,
    nonce: 1,
    sender: MINING_TRACKER_ADDRESS,
    activationHeight: 10,
    validators: [{ address: addr(BOB), publicKey: pub(BOB) }],
    approvals: [],
    timestampMs: T0 + 1
  }, key(ALICE), pub(ALICE));
  assertBothAppliersReserveTracker(config, validatorUpdate, "validator update sender");
  const protocolUpgrade = createProtocolUpgrade({
    chainId: CHAIN_ID,
    nonce: 1,
    sender: MINING_TRACKER_ADDRESS,
    activationHeight: 10,
    protocolVersion: 6,
    approvals: [],
    timestampMs: T0 + 1
  }, key(ALICE), pub(ALICE));
  assertBothAppliersReserveTracker(config, protocolUpgrade, "protocol upgrade sender");
});

test("D62-I1 positive control: the same shapes with ordinary addresses are still applied by State-v2", () => {
  const config = genesis();
  const state = freshStateV2(config);
  const afterTransfer = applyStateV2Transaction(state, transfer(addr(ALICE), addr(BOB), ALICE), config.activityPool);
  assert.equal(stateV2Balance(afterTransfer, addr(BOB)), 1);
  assert.equal(stateV2Nonce(afterTransfer, addr(ALICE)), 1);
  const afterSettlement = applyStateV2Transaction(state, settlement(config, [addr(BOB)]), config.activityPool);
  assert.equal(stateV2Balance(afterSettlement, addr(BOB)), 1);
  assert.equal(stateV2Nonce(afterSettlement, config.activityPool), 1);
  const upgrade = createProtocolUpgrade({
    chainId: CHAIN_ID,
    nonce: 1,
    sender: addr(VALIDATOR),
    activationHeight: 10,
    protocolVersion: 6,
    approvals: [],
    timestampMs: T0 + 1
  }, key(VALIDATOR), pub(VALIDATOR));
  assert.equal(stateV2Nonce(applyStateV2Transaction(state, upgrade, config.activityPool), addr(VALIDATOR)), 1);
  // Tracker untouched in every positive case.
  for (const next of [afterTransfer, afterSettlement]) {
    assert.equal(stateV2Balance(next, MINING_TRACKER_ADDRESS), 0);
    assert.equal(stateV2Nonce(next, MINING_TRACKER_ADDRESS), 0);
  }
});
