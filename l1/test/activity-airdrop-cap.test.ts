import assert from "node:assert/strict";
import test from "node:test";

import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, SparseMerkleState, stateV2Balance } from "../src/state-v2.js";
import {
  assertFixedSupplyGenesis,
  buildFixedSupplyAllocations,
  ECOSYSTEM_RESERVE_ATOMS
} from "../src/tokenomics.js";
import { createActivitySettlement, createTransfer } from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

/**
 * ZC-CRY-20260930-006 (owner decision 2026-09-30): the activity airdrop is paid
 * only from the 5M ecosystem/community allocation and can never exceed it.
 */

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const roles = { founder: addr(71), publicDistribution: addr(72), liquidityReserve: addr(73), ecosystemReserve: addr(74) };
const genesis: GenesisConfig = {
  chainId: "zyron-airdrop-cap-1",
  timestampMs: 1_700_000_000_000,
  validators: [{ address: addr(75), publicKey: pub(75) }],
  activityOracles: [pub(76)],
  activityPool: roles.ecosystemReserve,
  allocations: buildFixedSupplyAllocations(roles)
};
const alice = addr(77);

function settlement(epoch: number, nonce: number, amountAtoms: number, receiver = alice) {
  return createActivitySettlement({
    chainId: genesis.chainId, nonce, sender: roles.ecosystemReserve, epoch,
    entries: [{ receiver, amountAtoms }], receiptRoot: "00".repeat(32), timestampMs: genesis.timestampMs + epoch + 1
  }, key(76), pub(76));
}

function finalize(chain: ZyronChain, txs: Parameters<ZyronChain["produceBlock"]>[0]) {
  const timestampMs = genesis.timestampMs + (chain.height + 1) * 1_000;
  let block = chain.produceBlock(txs, key(75), { timestampMs });
  block = chain.attestBlock(block, key(75));
  chain.acceptBlock(block, timestampMs);
}

test("CRYPTO-REVIEW: cumulative activity airdrops stop at exactly the 5M ecosystem allocation", () => {
  assert.doesNotThrow(() => assertFixedSupplyGenesis(genesis, roles));
  const chain = new ZyronChain(genesis);
  assert.equal(chain.balance(roles.ecosystemReserve), ECOSYSTEM_RESERVE_ATOMS);

  finalize(chain, [settlement(0, 1, ECOSYSTEM_RESERVE_ATOMS - 1)]);
  assert.equal(chain.balance(alice), ECOSYSTEM_RESERVE_ATOMS - 1);

  assert.throws(() => chain.validateMempoolAdmission(settlement(1, 2, 2)), /Activity pool exhausted/);
  assert.throws(() => finalize(chain, [settlement(1, 2, 2)]), /Activity pool exhausted/);

  // Refilling the pool from another allocation is refused on every path.
  const refill = createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: roles.founder, receiver: roles.ecosystemReserve,
    amountAtoms: 1_000_000, feeAtoms: 0, timestampMs: genesis.timestampMs + 5
  }, key(71), pub(71));
  assert.throws(() => chain.validateMempoolAdmission(refill), /Activity pool cannot receive funds/);
  assert.throws(() => chain.validatePending([refill]), /Activity pool cannot receive funds/);
  assert.deepEqual(chain.selectValidPending([refill], 10), []);
  assert.throws(() => finalize(chain, [refill]), /Activity pool cannot receive funds/);

  // A settlement cannot route funds back into the pool either.
  assert.throws(() => chain.validateMempoolAdmission(settlement(1, 2, 1, roles.ecosystemReserve)), /Activity pool cannot receive funds/);

  finalize(chain, [settlement(1, 2, 1)]);
  assert.equal(chain.balance(roles.ecosystemReserve), 0);
  assert.equal(chain.balance(alice), ECOSYSTEM_RESERVE_ATOMS, "total airdropped equals the 5M allocation exactly");
  assert.throws(() => finalize(chain, [settlement(2, 3, 1)]), /Activity pool exhausted/);
});

test("CRYPTO-REVIEW: legacy and State-v2 appliers both refuse activity-pool inflows", () => {
  const refill = createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: roles.founder, receiver: roles.ecosystemReserve,
    amountAtoms: 1, feeAtoms: 0, timestampMs: 1
  }, key(71), pub(71), 2);
  const ledger = LedgerState.fromGenesis(genesis);
  assert.throws(() => ledger.apply(refill, roles.ecosystemReserve), /Activity pool cannot receive funds/);
  const sparse = SparseMerkleState.empty().set(`account:${roles.founder}`, { balanceAtoms: 10, nonce: 0 });
  assert.throws(() => applyStateV2Transaction(sparse, refill, roles.ecosystemReserve), /Activity pool cannot receive funds/);
  assert.equal(stateV2Balance(sparse, roles.ecosystemReserve), 0);
});
