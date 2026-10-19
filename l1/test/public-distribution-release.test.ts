// public-distribution-release-v1: the 20M public-distribution allocation is
// not spendable on day one when a value-bearing genesis declares the schedule.
// The address is a test placeholder. Supply stays 50,000,000 ZYN.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { allocationLockContext, MS_PER_DAY } from "../src/allocation-locks.js";
import { ZyronChain } from "../src/chain.js";
import { linearCliffVestedAtoms } from "../src/founder-vesting.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ChainStore } from "../src/storage.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import { createTransfer } from "../src/transaction.js";
import { MINING_TRACKER_ADDRESS } from "../src/mining.js";
import {
  defaultPublicDistributionRelease,
  PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS,
  PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS,
  PUBLIC_DISTRIBUTION_LOCKED_MESSAGE,
  PUBLIC_DISTRIBUTION_MAX_CLIFF_MS,
  PUBLIC_DISTRIBUTION_MAX_LINEAR_MS,
  PUBLIC_DISTRIBUTION_MIN_CLIFF_MS,
  PUBLIC_DISTRIBUTION_MIN_LINEAR_MS
} from "../src/public-distribution-release.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type GenesisConfig } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const T0 = 1_700_000_000_000;
const LOCKED = new RegExp(PUBLIC_DISTRIBUTION_LOCKED_MESSAGE);
const REQUIRED = /must declare publicDistributionRelease/;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATORS = [0x21, 0x22, 0x23, 0x24];
const ORACLE = 0x12;
const FOUNDER = 0x13;
const PUBLIC = 0x14;
const LIQUIDITY = 0x15;
const ECOSYSTEM = 0x16;
const ALICE = 0x17;
const PUBLIC_ATOMS = 20_000_000 * ZYN;

function release(cliffMs = PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, linearMs = PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS) {
  return { address: addr(PUBLIC), cliffMs, linearMs };
}

function strictGenesis(schedule: GenesisConfig["publicDistributionRelease"] | "omit" = release()): GenesisConfig {
  const genesis: GenesisConfig = {
    chainId: "zyron-review-distribution",
    timestampMs: T0,
    validators: VALIDATORS.map((id) => ({ address: addr(id), publicKey: pub(id) })),
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: 5_000_000 * ZYN },
      { address: addr(PUBLIC), amountAtoms: PUBLIC_ATOMS },
      { address: addr(LIQUIDITY), amountAtoms: 20_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) },
    launchProfile: "fixed-supply-v1",
    networkClass: "mainnet"
  };
  if (schedule !== "omit") genesis.publicDistributionRelease = schedule;
  return genesis;
}

function transfer(genesis: GenesisConfig, sender: number, amountAtoms: number, feeAtoms = 0, receiver = ALICE) {
  return createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: addr(sender), receiver: addr(receiver),
    amountAtoms, feeAtoms, timestampMs: T0 + 1
  }, key(sender), pub(sender), 1);
}

test("documented default and day-one floor are explicit and do not change the supply cap", () => {
  assert.equal(MAX_SUPPLY_ATOMS, 50_000_000 * ZYN);
  assert.equal(PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, 90 * MS_PER_DAY);
  assert.equal(PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS, 1_095 * MS_PER_DAY);
  assert.equal(PUBLIC_DISTRIBUTION_MIN_CLIFF_MS, MS_PER_DAY);
  assert.equal(PUBLIC_DISTRIBUTION_MIN_LINEAR_MS, 365 * MS_PER_DAY);
  assert.deepEqual(defaultPublicDistributionRelease(addr(PUBLIC)), release());
});

test("a value-bearing genesis without a release schedule is rejected at construction and node start", async () => {
  for (const networkClass of ["mainnet", "public-launch", "value-bearing"] as const) {
    const named = strictGenesis("omit");
    named.networkClass = networkClass;
    assert.throws(() => new ZyronChain(named), REQUIRED, networkClass);
  }
  const genesis = strictGenesis("omit");
  assert.throws(() => new ZyronChain(genesis), REQUIRED);
  const directory = await mkdtemp(join(tmpdir(), "zyron-release-required-"));
  try {
    await assert.rejects(() => ChainStore.open(genesis, directory), REQUIRED);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schedules that would unlock on day one, or that are malformed, are rejected", () => {
  const rejected: Array<[GenesisConfig["publicDistributionRelease"], RegExp]> = [
    [release(0, PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS), /cliffMs/],
    [release(MS_PER_DAY - 1, PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS), /cliffMs/],
    [release(PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, 0), /linearMs/],
    [release(PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, PUBLIC_DISTRIBUTION_MIN_LINEAR_MS - 1), /linearMs/],
    [release(-1, PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS), /cliffMs/],
    [{ address: addr(FOUNDER), cliffMs: PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, linearMs: PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS }, /founder or permanent-liquidity/],
    [{ address: addr(LIQUIDITY), cliffMs: PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, linearMs: PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS }, /founder or permanent-liquidity/],
    [{ address: addr(ECOSYSTEM), cliffMs: PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, linearMs: PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS }, /activity pool/],
    [{ address: addr(ALICE), cliffMs: PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, linearMs: PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS }, /needs a genesis allocation/],
    [{ address: MINING_TRACKER_ADDRESS, cliffMs: PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, linearMs: PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS }, /mining tracker/],
    [release(PUBLIC_DISTRIBUTION_MAX_CLIFF_MS + 1, PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS), /cliffMs/],
    [release(PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS, PUBLIC_DISTRIBUTION_MAX_LINEAR_MS + 1), /linearMs/]
  ];
  for (const [schedule, error] of rejected) {
    assert.throws(() => new ZyronChain(strictGenesis(schedule)), error, JSON.stringify(schedule));
  }
  const extra = strictGenesis(release()) as GenesisConfig & { publicDistributionRelease: Record<string, unknown> };
  extra.publicDistributionRelease.note = "early";
  assert.throws(() => new ZyronChain(extra), /Invalid public distribution release fields/);
  const fractional = strictGenesis(release());
  fractional.publicDistributionRelease = { address: addr(PUBLIC), cliffMs: 1.5, linearMs: PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS };
  assert.throws(() => new ZyronChain(fractional), /cliffMs/);
});

test("the minimum schedule is accepted and still locks the allocation through day one", () => {
  const genesis = strictGenesis(release(PUBLIC_DISTRIBUTION_MIN_CLIFF_MS, PUBLIC_DISTRIBUTION_MIN_LINEAR_MS));
  const chain = new ZyronChain(genesis);
  const dayOne = T0 + MS_PER_DAY;
  assert.equal(chain.spendableBalance(addr(PUBLIC), dayOne), 0);
  assert.throws(() => chain.validateMempoolAdmission(transfer(genesis, PUBLIC, 1), dayOne), LOCKED);
  const justAfter = dayOne + 1;
  const vested = Number(linearCliffVestedAtoms(
    BigInt(justAfter - T0),
    BigInt(PUBLIC_DISTRIBUTION_MIN_CLIFF_MS),
    BigInt(PUBLIC_DISTRIBUTION_MIN_LINEAR_MS),
    BigInt(PUBLIC_ATOMS)
  ));
  assert.ok(vested > 0 && vested < PUBLIC_ATOMS);
  assert.equal(chain.spendableBalance(addr(PUBLIC), justAfter), vested);
});

test("day-one spend of the public distribution is rejected on chain paths and both appliers", () => {
  const genesis = strictGenesis();
  const chain = new ZyronChain(genesis);
  const at = T0 + 60_000;
  const tx = transfer(genesis, PUBLIC, 1, 1);
  assert.equal(chain.spendableBalance(addr(PUBLIC), at), 0);
  assert.throws(() => chain.validateMempoolAdmission(tx, at), LOCKED);
  assert.deepEqual(chain.selectValidPending([tx], 10, 1_500_000, at), []);
  assert.throws(() => chain.produceBlock([tx], key(VALIDATORS[0]!), { timestampMs: at }), LOCKED);
  const ledger = chain.getState();
  assert.throws(() => ledger.apply(tx, genesis.activityPool, allocationLockContext(genesis, at), genesis), LOCKED);
  assert.equal(ledger.balance(addr(PUBLIC)), PUBLIC_ATOMS);
  const sparse = stateV2FromLedgerSnapshot(LedgerState.fromSnapshot(ledger.snapshot()).snapshot());
  assert.throws(() => applyStateV2Transaction(sparse, tx, genesis.activityPool, allocationLockContext(genesis, at), genesis), LOCKED);
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
  assert.equal(chain.balance(addr(PUBLIC)), PUBLIC_ATOMS);
});

test("the default schedule releases nothing at the cliff and the full allocation only after the linear term", () => {
  const genesis = strictGenesis();
  const chain = new ZyronChain(genesis);
  const cliff = T0 + PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS;
  assert.equal(chain.spendableBalance(addr(PUBLIC), cliff), 0);
  assert.throws(() => chain.produceBlock([transfer(genesis, PUBLIC, 1)], key(VALIDATORS[0]!), { timestampMs: cliff }), LOCKED);
  const oneMs = cliff + 1;
  const vestedAt = Number(linearCliffVestedAtoms(
    BigInt(oneMs - T0),
    BigInt(PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS),
    BigInt(PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS),
    BigInt(PUBLIC_ATOMS)
  ));
  assert.ok(vestedAt > 0 && vestedAt < PUBLIC_ATOMS);
  assert.equal(chain.spendableBalance(addr(PUBLIC), oneMs), vestedAt);
  const exact = transfer(genesis, PUBLIC, vestedAt, 0);
  const over = transfer(genesis, PUBLIC, vestedAt + 1, 0);
  assert.doesNotThrow(() => chain.produceBlock([exact], key(VALIDATORS[0]!), { timestampMs: oneMs }));
  assert.throws(() => chain.produceBlock([over], key(VALIDATORS[0]!), { timestampMs: oneMs }), LOCKED);

  const done = T0 + PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS + PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS;
  assert.equal(chain.spendableBalance(addr(PUBLIC), done), PUBLIC_ATOMS);
  let block = chain.produceBlock([transfer(genesis, PUBLIC, PUBLIC_ATOMS, 0)], key(VALIDATORS[0]!), { timestampMs: done });
  for (const id of VALIDATORS.slice(0, 3)) block = chain.attestBlock(block, key(id));
  chain.acceptBlock(block, done);
  assert.equal(chain.balance(addr(PUBLIC)), 0);
  assert.equal(chain.balance(addr(ALICE)), PUBLIC_ATOMS);
  assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
});

test("inflows above the still-locked genesis allocation are spendable during the cliff", () => {
  const holder = 0x31;
  const funder = 0x32;
  const genesis: GenesisConfig = {
    chainId: "zyron-devnet-release",
    timestampMs: T0,
    networkClass: "devnet",
    validators: [{ address: addr(VALIDATORS[0]!), publicKey: pub(VALIDATORS[0]!) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(holder), amountAtoms: 1_000 * ZYN },
      { address: addr(funder), amountAtoms: 100 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 0 }
    ],
    publicDistributionRelease: {
      address: addr(holder),
      cliffMs: PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS,
      linearMs: PUBLIC_DISTRIBUTION_DEFAULT_LINEAR_MS
    }
  };
  const chain = new ZyronChain(genesis);
  const at = T0 + 60_000;
  assert.equal(chain.spendableBalance(addr(holder), at), 0);
  const inbound = createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: addr(funder), receiver: addr(holder),
    amountAtoms: 50 * ZYN, feeAtoms: 0, timestampMs: T0 + 1
  }, key(funder), pub(funder), 1);
  let block = chain.produceBlock([inbound], key(VALIDATORS[0]!), { timestampMs: at });
  block = chain.attestBlock(block, key(VALIDATORS[0]!));
  chain.acceptBlock(block, at);
  assert.equal(chain.balance(addr(holder)), 1_050 * ZYN);
  assert.equal(chain.spendableBalance(addr(holder), at + 1), 50 * ZYN);
  const spendInflow = createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: addr(holder), receiver: addr(ALICE),
    amountAtoms: 50 * ZYN, feeAtoms: 0, timestampMs: T0 + 2
  }, key(holder), pub(holder), 1);
  const spendAllocation = createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: addr(holder), receiver: addr(ALICE),
    amountAtoms: 50 * ZYN + 1, feeAtoms: 0, timestampMs: T0 + 2
  }, key(holder), pub(holder), 1);
  assert.doesNotThrow(() => chain.produceBlock([spendInflow], key(VALIDATORS[0]!), { timestampMs: at + 1 }));
  assert.throws(() => chain.produceBlock([spendAllocation], key(VALIDATORS[0]!), { timestampMs: at + 1 }), LOCKED);
});

test("open testnet and wallet testnet shapes without the field keep day-one spend and the historical hash rule", () => {
  const open: GenesisConfig = {
    chainId: "zyron-open-testnet-1",
    timestampMs: T0,
    validators: [{ address: addr(VALIDATORS[0]!), publicKey: pub(VALIDATORS[0]!) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: 5_000_000 * ZYN },
      { address: addr(PUBLIC), amountAtoms: PUBLIC_ATOMS },
      { address: addr(LIQUIDITY), amountAtoms: 20_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) },
    launchProfile: "fixed-supply-v1"
  };
  const chain = new ZyronChain(open);
  assert.equal(chain.spendableBalance(addr(PUBLIC), T0 + 1_000), PUBLIC_ATOMS);
  assert.equal(allocationLockContext(open, T0 + 1_000)?.publicDistribution, undefined);
  const wallet: GenesisConfig = {
    chainId: "zyron-wallet-testnet-1",
    timestampMs: T0,
    validators: [{ address: addr(VALIDATORS[0]!), publicKey: pub(VALIDATORS[0]!) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [{ address: addr(PUBLIC), amountAtoms: 1_000 * ZYN }, { address: addr(ECOSYSTEM), amountAtoms: 0 }]
  };
  const walletChain = new ZyronChain(wallet);
  assert.equal(walletChain.tip.header.previousHash, "0".repeat(64));
  assert.equal(walletChain.spendableBalance(addr(PUBLIC), T0 + 1_000), 1_000 * ZYN);

  const opted = { ...wallet, publicDistributionRelease: defaultPublicDistributionRelease(addr(PUBLIC)) };
  const bound = new ZyronChain(opted);
  assert.notEqual(bound.genesisHash, walletChain.genesisHash);
  assert.notEqual(bound.tip.header.previousHash, "0".repeat(64));
  assert.equal(bound.spendableBalance(addr(PUBLIC), T0 + 1_000), 0);
});

test("a fee is counted, and stripping the release from a value-bearing file is a different chain that cannot start", () => {
  const genesis = strictGenesis();
  const chain = new ZyronChain(genesis);
  const at = T0 + PUBLIC_DISTRIBUTION_DEFAULT_CLIFF_MS + 1;
  const vested = chain.spendableBalance(addr(PUBLIC), at);
  assert.throws(() => chain.produceBlock([transfer(genesis, PUBLIC, vested, 1)], key(VALIDATORS[0]!), { timestampMs: at }), LOCKED);
  assert.doesNotThrow(() => chain.produceBlock([transfer(genesis, PUBLIC, vested - 1, 1)], key(VALIDATORS[0]!), { timestampMs: at }));
  const stripped = structuredClone(genesis);
  delete stripped.publicDistributionRelease;
  assert.throws(() => new ZyronChain(stripped), REQUIRED);
  assert.notEqual(chain.genesisHash, new ZyronChain(strictGenesis(release(PUBLIC_DISTRIBUTION_MIN_CLIFF_MS, PUBLIC_DISTRIBUTION_MIN_LINEAR_MS))).genesisHash);
});
