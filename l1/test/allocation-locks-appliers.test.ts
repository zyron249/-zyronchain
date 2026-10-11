// Raw state appliers and helpers behind the on-chain allocation locks
// (docs/ALLOCATION_LOCKS.md). The chain-level paths are covered by
// allocation-locks.test.ts; this file pins the shared arithmetic, both ledger
// appliers when reached directly, and fail-closed genesis validation.
import assert from "node:assert/strict";
import test from "node:test";

import {
  allocationLockContext,
  assertAllocationLockOutflow,
  FOUNDER_VESTING_CLIFF_MS,
  FOUNDER_VESTING_LINEAR_MS,
  founderLockedAtomsAtTimestamp,
  founderVestedAtomsAtTimestamp,
  lockedAtoms,
  spendableAtoms,
  validateAllocationLocks
} from "../src/allocation-locks.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  BLOCKS_PER_DAY,
  FOUNDER_CLIFF_BLOCKS,
  FOUNDER_LINEAR_VESTING_BLOCKS,
  founderVestedAtomsAtHeight,
  linearCliffVestedAtoms,
  TARGET_BLOCK_INTERVAL_SECONDS
} from "../src/founder-vesting.js";
import { MINING_TRACKER_ADDRESS } from "../src/mining.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, stateV2Balance, stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import { FOUNDER_ALLOCATION_ATOMS } from "../src/tokenomics.js";
import { createActivitySettlement, createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type GenesisConfig } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const DAY_MS = 86_400_000;
const VESTING = /Founder allocation is still vesting/;
const LIQUIDITY_LOCKED = /Permanent-liquidity reserve is locked/;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 91;
const ORACLE = 92;
const FOUNDER = 93;
const LIQUIDITY = 94;
const POOL = 95;
const ALICE = 96;
const G = 1_700_000_000_000;

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-lock-appliers",
    timestampMs: G,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(POOL),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: FOUNDER_ALLOCATION_ATOMS },
      { address: addr(LIQUIDITY), amountAtoms: 20_000_000 * ZYN },
      { address: addr(POOL), amountAtoms: 1_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) }
  } as GenesisConfig;
}

function transfer(sender: number, amountAtoms: number, feeAtoms = 0, receiver = ALICE) {
  return createTransfer({
    chainId: "zyron-lock-appliers", nonce: 1, sender: addr(sender), receiver: addr(receiver),
    amountAtoms, feeAtoms, timestampMs: G + 1
  }, key(sender), pub(sender), 2);
}

test("ALLOCATION-LOCKS appliers: timestamp and block-height schedules agree exactly at the 30 s target", () => {
  assert.equal(TARGET_BLOCK_INTERVAL_SECONDS, 30);
  assert.equal(FOUNDER_VESTING_CLIFF_MS, FOUNDER_CLIFF_BLOCKS * TARGET_BLOCK_INTERVAL_SECONDS * 1_000);
  assert.equal(FOUNDER_VESTING_LINEAR_MS, FOUNDER_LINEAR_VESTING_BLOCKS * TARGET_BLOCK_INTERVAL_SECONDS * 1_000);
  const heights = [
    0, 1, FOUNDER_CLIFF_BLOCKS - 1, FOUNDER_CLIFF_BLOCKS, FOUNDER_CLIFF_BLOCKS + 1, FOUNDER_CLIFF_BLOCKS + 2,
    FOUNDER_CLIFF_BLOCKS + BLOCKS_PER_DAY, FOUNDER_CLIFF_BLOCKS + 123_457,
    FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS / 2,
    FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS - 1,
    FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS,
    FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS + 1,
    10 * (FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS)
  ];
  for (let h = FOUNDER_CLIFF_BLOCKS; h < FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS; h += 99_991) heights.push(h);
  for (const height of heights) {
    assert.equal(
      founderVestedAtomsAtTimestamp(G, G + height * 30_000, FOUNDER_ALLOCATION_ATOMS),
      founderVestedAtomsAtHeight(height),
      `height ${height}`
    );
  }
});

test("ALLOCATION-LOCKS appliers: shared arithmetic floors, saturates and rejects bad input", () => {
  assert.equal(linearCliffVestedAtoms(0n, 10n, 3n, 10n), 0n);
  assert.equal(linearCliffVestedAtoms(10n, 10n, 3n, 10n), 0n, "nothing at exactly the cliff");
  assert.equal(linearCliffVestedAtoms(11n, 10n, 3n, 10n), 3n, "floor(10 * 1 / 3)");
  assert.equal(linearCliffVestedAtoms(12n, 10n, 3n, 10n), 6n);
  assert.equal(linearCliffVestedAtoms(13n, 10n, 3n, 10n), 10n);
  assert.equal(linearCliffVestedAtoms(10n ** 30n, 10n, 3n, 10n), 10n, "saturates at the total");
  assert.equal(linearCliffVestedAtoms(-5n, 10n, 3n, 10n), 0n, "before the start nothing vests");
  assert.throws(() => linearCliffVestedAtoms(1n, -1n, 3n, 10n), /Invalid vesting schedule/);
  assert.throws(() => linearCliffVestedAtoms(1n, 1n, 0n, 10n), /Invalid vesting schedule/);
  assert.throws(() => linearCliffVestedAtoms(1n, 1n, 3n, -1n), /Invalid vesting schedule/);

  assert.equal(founderVestedAtomsAtTimestamp(G, G - 1, FOUNDER_ALLOCATION_ATOMS), 0);
  assert.equal(founderVestedAtomsAtTimestamp(G, G + FOUNDER_VESTING_CLIFF_MS, FOUNDER_ALLOCATION_ATOMS), 0);
  assert.equal(founderVestedAtomsAtTimestamp(G, G + FOUNDER_VESTING_CLIFF_MS + FOUNDER_VESTING_LINEAR_MS, FOUNDER_ALLOCATION_ATOMS), FOUNDER_ALLOCATION_ATOMS);
  assert.equal(founderVestedAtomsAtTimestamp(G, Number.MAX_SAFE_INTEGER, FOUNDER_ALLOCATION_ATOMS), FOUNDER_ALLOCATION_ATOMS);
  assert.equal(founderLockedAtomsAtTimestamp(G, G + 1, FOUNDER_ALLOCATION_ATOMS), FOUNDER_ALLOCATION_ATOMS);
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => founderVestedAtomsAtTimestamp(bad, G, FOUNDER_ALLOCATION_ATOMS), /Invalid/);
    assert.throws(() => founderVestedAtomsAtTimestamp(G, bad, FOUNDER_ALLOCATION_ATOMS), /Invalid/);
    assert.throws(() => founderVestedAtomsAtTimestamp(G, G, bad), /Invalid/);
  }
  // The block-height helper keeps its previous behaviour.
  assert.equal(founderVestedAtomsAtHeight(FOUNDER_CLIFF_BLOCKS), 0);
  assert.equal(founderVestedAtomsAtHeight(FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS), FOUNDER_ALLOCATION_ATOMS);
  assert.throws(() => founderVestedAtomsAtHeight(-1), /Invalid height/);
});

test("ALLOCATION-LOCKS appliers: lock helpers report locked and spendable amounts", () => {
  const config = genesis();
  assert.equal(allocationLockContext({ ...config, allocationLocks: undefined } as unknown as GenesisConfig, G + 1), undefined);
  const { allocationLocks: _omitted, ...unlocked } = config;
  assert.equal(allocationLockContext(unlocked as GenesisConfig, G + 1), undefined);
  const mid = allocationLockContext(config, G + FOUNDER_VESTING_CLIFF_MS + FOUNDER_VESTING_LINEAR_MS / 2)!;
  assert.equal(lockedAtoms(mid, addr(FOUNDER), FOUNDER_ALLOCATION_ATOMS), FOUNDER_ALLOCATION_ATOMS / 2);
  assert.equal(spendableAtoms(mid, addr(FOUNDER), FOUNDER_ALLOCATION_ATOMS), FOUNDER_ALLOCATION_ATOMS / 2);
  assert.equal(spendableAtoms(mid, addr(FOUNDER), FOUNDER_ALLOCATION_ATOMS / 4), 0, "never negative");
  assert.equal(lockedAtoms(mid, addr(LIQUIDITY), 123), 123);
  assert.equal(spendableAtoms(mid, addr(LIQUIDITY), 123), 0);
  assert.equal(lockedAtoms(mid, addr(ALICE), 123), 0);
  assert.equal(spendableAtoms(undefined, addr(LIQUIDITY), 123), 123);
  assert.doesNotThrow(() => assertAllocationLockOutflow(mid, addr(FOUNDER), FOUNDER_ALLOCATION_ATOMS, FOUNDER_ALLOCATION_ATOMS / 2));
  assert.throws(() => assertAllocationLockOutflow(mid, addr(FOUNDER), FOUNDER_ALLOCATION_ATOMS, FOUNDER_ALLOCATION_ATOMS / 2 + 1), VESTING);
  assert.throws(() => assertAllocationLockOutflow(mid, addr(LIQUIDITY), 123, 0), LIQUIDITY_LOCKED);
  assert.doesNotThrow(() => assertAllocationLockOutflow(undefined, addr(LIQUIDITY), 123, 123));
  assert.doesNotThrow(() => assertAllocationLockOutflow(mid, addr(ALICE), 123, 123));
});

test("ALLOCATION-LOCKS appliers: LedgerState and State-v2 refuse locked outflows when given the lock context", () => {
  const config = genesis();
  const cliff = allocationLockContext(config, G + 1_000)!;
  const mid = allocationLockContext(config, G + FOUNDER_VESTING_CLIFF_MS + FOUNDER_VESTING_LINEAR_MS / 2)!;
  const ledger = () => LedgerState.fromGenesis(config);
  const sparse = () => stateV2FromLedgerSnapshot(LedgerState.fromGenesis(config).snapshot());
  const half = FOUNDER_ALLOCATION_ATOMS / 2;

  for (const [ctx, tx, error] of [
    [cliff, transfer(FOUNDER, 1), VESTING],
    [mid, transfer(FOUNDER, half, 1), VESTING],
    [mid, transfer(FOUNDER, half + 1), VESTING],
    [mid, transfer(LIQUIDITY, 1), LIQUIDITY_LOCKED],
    [mid, transfer(LIQUIDITY, 1, 1), LIQUIDITY_LOCKED]
  ] as const) {
    const legacy = ledger();
    assert.throws(() => legacy.apply(tx, config.activityPool, ctx), error);
    assert.equal(legacy.balance(tx.sender), ledger().balance(tx.sender));
    assert.throws(() => applyStateV2Transaction(sparse(), tx, config.activityPool, ctx), error);
  }
  const ok = transfer(FOUNDER, half - 1, 1);
  const legacy = ledger();
  legacy.apply(ok, config.activityPool, mid);
  assert.equal(legacy.balance(addr(FOUNDER)), half);
  assert.equal(stateV2Balance(applyStateV2Transaction(sparse(), ok, config.activityPool, mid), addr(FOUNDER)), half);
  // Inflows to a locked account are accepted by both appliers.
  const inflow = createTransfer({
    chainId: config.chainId, nonce: 1, sender: addr(ALICE), receiver: addr(LIQUIDITY),
    amountAtoms: 5, feeAtoms: 0, timestampMs: G + 1
  }, key(ALICE), pub(ALICE), 2);
  const funded = ledger();
  funded.apply(createTransfer({
    chainId: config.chainId, nonce: 1, sender: addr(FOUNDER), receiver: addr(ALICE),
    amountAtoms: 10, feeAtoms: 0, timestampMs: G + 1
  }, key(FOUNDER), pub(FOUNDER), 2), config.activityPool);
  funded.apply(inflow, config.activityPool, cliff);
  assert.equal(funded.balance(addr(LIQUIDITY)), 20_000_000 * ZYN + 5);
  // Without a lock context (raw callers, historical replays of unlocked genesis) behaviour is unchanged.
  assert.doesNotThrow(() => ledger().apply(transfer(LIQUIDITY, 1), config.activityPool));
  assert.doesNotThrow(() => applyStateV2Transaction(sparse(), transfer(LIQUIDITY, 1), config.activityPool));
});

test("ALLOCATION-LOCKS appliers: activity settlements from a locked account are refused by both appliers", () => {
  // Genesis validation forbids a locked activity pool; the appliers still refuse it.
  const config = genesis();
  const ctx = allocationLockContext(config, G + 2 * DAY_MS)!;
  const settlement = createActivitySettlement({
    chainId: config.chainId, nonce: 1, sender: addr(LIQUIDITY), epoch: 0,
    entries: [{ receiver: addr(ALICE), amountAtoms: 1 }], receiptRoot: "00".repeat(32), timestampMs: G + 1
  }, key(ORACLE), pub(ORACLE), 2);
  assert.throws(() => LedgerState.fromGenesis(config).apply(settlement, addr(LIQUIDITY), ctx), LIQUIDITY_LOCKED);
  assert.throws(
    () => applyStateV2Transaction(stateV2FromLedgerSnapshot(LedgerState.fromGenesis(config).snapshot()), settlement, addr(LIQUIDITY), ctx),
    LIQUIDITY_LOCKED
  );
});

test("ALLOCATION-LOCKS appliers: malformed allocationLocks fail closed at genesis", () => {
  const base = genesis();
  const variants: Array<[string, unknown]> = [
    ["not an object", "locks"],
    ["null", null],
    ["missing role", { founderVesting: addr(FOUNDER) }],
    ["extra key", { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY), ecosystem: addr(POOL) }],
    ["invalid address", { founderVesting: "ZYNnot-an-address", permanentLiquidity: addr(LIQUIDITY) }],
    ["same address", { founderVesting: addr(FOUNDER), permanentLiquidity: addr(FOUNDER) }],
    ["mining tracker", { founderVesting: MINING_TRACKER_ADDRESS, permanentLiquidity: addr(LIQUIDITY) }],
    ["activity pool", { founderVesting: addr(FOUNDER), permanentLiquidity: addr(POOL) }],
    ["no genesis allocation", { founderVesting: addr(ALICE), permanentLiquidity: addr(LIQUIDITY) }]
  ];
  assert.equal(variants.length, 9);
  for (const [name, locks] of variants) {
    const candidate = { ...base, allocationLocks: locks } as unknown as GenesisConfig;
    assert.throws(() => validateAllocationLocks(candidate), /allocation lock|Invalid/i, name);
    assert.throws(() => new ZyronChain(candidate), /allocation lock|Invalid/i, name);
  }
  assert.doesNotThrow(() => validateAllocationLocks(base));
  assert.doesNotThrow(() => new ZyronChain(base));
});
