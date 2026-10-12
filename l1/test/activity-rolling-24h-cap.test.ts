// Owner rule: at most 10,000 ZYN of activity settlements per 24 hours.
// The per-epoch cap alone lets two adjacent epochs be settled one millisecond
// apart around an epoch boundary (20,000 ZYN inside one 24 h window, see
// activity-oracle-epoch-bound.test.ts). Under `launchProfile: "fixed-supply-v1"`
// consensus now also enforces a rolling window: the settlements whose block
// timestamps lie within any 24 h window (t, t + 24 h) never sum to more than
// 10,000 ZYN. Genesis files without a launch profile keep the per-epoch rule
// unchanged (existing chains do not fork). Supply and allocations do not
// change; settlements still come only from the activity pool.
import assert from "node:assert/strict";
import test from "node:test";

import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { allocationLockContext } from "../src/allocation-locks.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import {
  createActivitySettlement,
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer
} from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type ActivitySettlementTx, type Address, type GenesisConfig } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const EPOCH_MS = 86_400_000;
const CAP = 10_000 * ZYN;
const POOL = 5_000_000 * ZYN;
const ROLLING = /rolling 24-hour/;
const RESERVED = /protocol-reserved/;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 61;
const ORACLE = 62;
const FOUNDER = 63;
const PUBLIC_DISTRIBUTION = 64;
const LIQUIDITY = 65;
const ECOSYSTEM = 66;
const ALICE = 67;
const WINDOW_TIME = `ZYN${"0".repeat(39)}1` as Address;
const WINDOW_AMOUNT = `ZYN${"0".repeat(39)}2` as Address;

function genesisFor(chainId: string, profile: boolean): GenesisConfig {
  const genesis: GenesisConfig = {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: 5_000_000 * ZYN },
      { address: addr(PUBLIC_DISTRIBUTION), amountAtoms: 20_000_000 * ZYN },
      { address: addr(LIQUIDITY), amountAtoms: 20_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: POOL }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) }
  };
  return profile ? { ...genesis, launchProfile: "fixed-supply-v1" } : genesis;
}

function finalize(chain: ZyronChain, txs: Parameters<ZyronChain["produceBlock"]>[0], timestampMs: number): void {
  let block = chain.produceBlock(txs, key(VALIDATOR), { timestampMs });
  if (isConsensusV6(chain.protocolVersionAt(block.header.height))) {
    block.commitRound = 0;
    block.attestations = [{
      validator: addr(VALIDATOR),
      publicKey: pub(VALIDATOR),
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(VALIDATOR))
    }];
  } else {
    block = chain.attestBlock(block, key(VALIDATOR));
  }
  chain.acceptBlock(block, timestampMs);
}

function chainAtVersion(genesis: GenesisConfig, version: number): ZyronChain {
  const chain = new ZyronChain(genesis);
  if (version === 1) return chain;
  const input = { chainId: genesis.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101, protocolVersion: version };
  const upgrade = createProtocolUpgrade({
    ...input,
    approvals: [createProtocolUpgradeApproval(input, key(VALIDATOR), pub(VALIDATOR))],
    timestampMs: genesis.timestampMs + 10
  }, key(VALIDATOR), pub(VALIDATOR));
  for (let height = 1; height <= 100; height += 1) {
    finalize(chain, height === 1 ? [upgrade] : [], genesis.timestampMs + height * 1_000);
  }
  assert.equal(chain.protocolVersionAt(chain.height + 1), version);
  return chain;
}

const boundary = (genesis: GenesisConfig, epoch: number) => genesis.timestampMs + epoch * EPOCH_MS;

function settlement(genesis: GenesisConfig, epoch: number, nonce: number, amountAtoms: number, txVersion: 1 | 2): ActivitySettlementTx {
  return createActivitySettlement({
    chainId: genesis.chainId, nonce, sender: genesis.activityPool, epoch,
    entries: [{ receiver: addr(ALICE), amountAtoms }],
    receiptRoot: "00".repeat(32), timestampMs: genesis.timestampMs + 1
  }, key(ORACLE), pub(ORACLE), txVersion);
}

function totalSupply(chain: ZyronChain, genesis: GenesisConfig): number {
  return [addr(FOUNDER), addr(PUBLIC_DISTRIBUTION), addr(LIQUIDITY), genesis.activityPool, addr(ALICE)]
    .reduce((sum, address) => sum + chain.balance(address), 0);
}

for (const version of [1, 3, 6]) {
  const txVersion = version >= 3 ? 2 : 1;

  test(`ROLLING-24H (v${version}): a boundary burst of two full epochs is rejected on every path`, () => {
    const genesis = genesisFor(`zyron-rolling-burst-v${version}`, true);
    const chain = chainAtVersion(genesis, version);
    finalize(chain, [settlement(genesis, 0, 1, CAP, txVersion)], boundary(genesis, 2) - 1);
    const second = settlement(genesis, 1, 2, 1, txVersion);
    for (const t of [boundary(genesis, 2), boundary(genesis, 2) + EPOCH_MS / 2, boundary(genesis, 3) - 2]) {
      assert.throws(() => chain.validatePending([second], t), ROLLING, `admission at +${t - boundary(genesis, 2)} ms`);
      assert.throws(() => chain.produceBlock([second], key(VALIDATOR), { timestampMs: t }), ROLLING);
    }
    assert.equal(POOL - chain.balance(genesis.activityPool), CAP);
    assert.equal(totalSupply(chain, genesis), MAX_SUPPLY_ATOMS);
  });

  test(`ROLLING-24H (v${version}): adjacent epochs share 10,000 ZYN inside 24 h and a full epoch is allowed once 24 h have passed`, () => {
    const genesis = genesisFor(`zyron-rolling-share-v${version}`, true);
    const chain = chainAtVersion(genesis, version);
    const first = boundary(genesis, 2) - 1;
    finalize(chain, [settlement(genesis, 0, 1, 6_000 * ZYN, txVersion)], first);
    assert.throws(() => chain.validatePending([settlement(genesis, 1, 2, 4_000 * ZYN + 1, txVersion)], boundary(genesis, 2)), ROLLING);
    finalize(chain, [settlement(genesis, 1, 2, 4_000 * ZYN, txVersion)], boundary(genesis, 2));
    // Epoch 2 is settleable from boundary(3); the previous payout (epoch 1, 4,000 ZYN)
    // was at boundary(2), exactly 24 h earlier, so a full epoch is allowed again.
    finalize(chain, [settlement(genesis, 2, 3, CAP, txVersion)], boundary(genesis, 3));
    // Epoch 3 one millisecond before 24 h after the last full payout: nothing is left.
    assert.throws(() => chain.validatePending([settlement(genesis, 3, 4, 1, txVersion)], boundary(genesis, 4) - 1), ROLLING);
    // A zero-amount settlement is still allowed and never widens the window.
    finalize(chain, [settlement(genesis, 3, 4, 0, txVersion)], boundary(genesis, 4) - 1);
    finalize(chain, [settlement(genesis, 4, 5, CAP, txVersion)], boundary(genesis, 5));
    assert.equal(POOL - chain.balance(genesis.activityPool), 30_000 * ZYN);
    assert.equal(totalSupply(chain, genesis), MAX_SUPPLY_ATOMS);
  });

  test(`ROLLING-24H (v${version}): a genesis without a launch profile keeps the per-epoch rule`, () => {
    const genesis = genesisFor(`zyron-rolling-legacy-v${version}`, false);
    const chain = chainAtVersion(genesis, version);
    finalize(chain, [settlement(genesis, 0, 1, CAP, txVersion)], boundary(genesis, 2) - 1);
    finalize(chain, [settlement(genesis, 1, 2, CAP, txVersion)], boundary(genesis, 2));
    assert.equal(POOL - chain.balance(genesis.activityPool), 2 * CAP);
    assert.equal(chain.balance(WINDOW_TIME), 0);
  });
}

test("ROLLING-24H: both state appliers enforce the window from the block timestamp", () => {
  const genesis = genesisFor("zyron-rolling-appliers", true);
  const first = settlement(genesis, 0, 1, CAP, 2);
  const second = settlement(genesis, 1, 2, 1, 2);
  const t1 = boundary(genesis, 2) - 1;
  const t2 = boundary(genesis, 2);
  const ledger = LedgerState.fromGenesis(genesis);
  ledger.apply(first, genesis.activityPool, allocationLockContext(genesis, t1), genesis);
  assert.throws(() => ledger.clone().apply(second, genesis.activityPool, allocationLockContext(genesis, t2), genesis), ROLLING);
  let sparse = stateV2FromLedgerSnapshot(LedgerState.fromGenesis(genesis).snapshot());
  sparse = applyStateV2Transaction(sparse, first, genesis.activityPool, allocationLockContext(genesis, t1), genesis);
  assert.throws(() => applyStateV2Transaction(sparse, second, genesis.activityPool, allocationLockContext(genesis, t2), genesis), ROLLING);
  // The window record is part of the committed state (both representations agree).
  assert.equal(ledger.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
  assert.equal(stateV2FromLedgerSnapshot(ledger.snapshot()).root(), sparse.root());
});

test("ROLLING-24H: the window-record addresses are protocol-reserved under the launch profile", () => {
  const genesis = genesisFor("zyron-rolling-reserved", true);
  const chain = new ZyronChain(genesis);
  const t = genesis.timestampMs + 1_000;
  for (const receiver of [WINDOW_TIME, WINDOW_AMOUNT]) {
    const transfer = createTransfer({
      chainId: genesis.chainId, nonce: 1, sender: addr(PUBLIC_DISTRIBUTION), receiver,
      amountAtoms: ZYN, feeAtoms: 0, timestampMs: genesis.timestampMs + 1
    }, key(PUBLIC_DISTRIBUTION), pub(PUBLIC_DISTRIBUTION));
    assert.throws(() => chain.validatePending([transfer], t), RESERVED);
    assert.throws(() => chain.produceBlock([transfer], key(VALIDATOR), { timestampMs: t }), RESERVED);
  }
  for (const address of [WINDOW_TIME, WINDOW_AMOUNT]) {
    const bad = genesisFor("zyron-rolling-reserved-genesis", true);
    bad.allocations = bad.allocations.map((allocation) =>
      allocation.address === addr(PUBLIC_DISTRIBUTION) ? { ...allocation, address } : allocation);
    assert.throws(() => new ZyronChain(bad));
  }
});
