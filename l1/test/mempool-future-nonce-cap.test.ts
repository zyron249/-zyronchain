// Red Team Session 1, MEDIUM 1: a transaction whose nonce leaves a gap above
// the sender's confirmed nonce ("future-nonce" or "parked") used to sit in the
// mempool with no per-address bound beyond the 64-nonce window and no expiry.
// Node mempool policy now caps parked transactions per address (default 16)
// and evicts parked transactions after a TTL (default 10 minutes). Block
// validity is unchanged.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  DEFAULT_MEMPOOL_MAX_FUTURE_NONCE_PER_SENDER,
  DEFAULT_MEMPOOL_PARKED_TX_TTL_MS,
  NodeService,
  type NodeServiceOptions
} from "../src/node.js";
import { ChainStore } from "../src/storage.js";
import { createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type GenesisConfig } from "../src/types.js";

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 91;
const ORACLE = 92;
const POOL = 93;
const ALICE = 94;
const BOB = 95;
const CAROL = 96;
const SINK = 97;

function genesis(chainId: string): GenesisConfig {
  return {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(POOL),
    allocations: [
      { address: addr(ALICE), amountAtoms: 1_000 * ATOMS_PER_ZYN },
      { address: addr(BOB), amountAtoms: 1_000 * ATOMS_PER_ZYN },
      { address: addr(CAROL), amountAtoms: 1_000 * ATOMS_PER_ZYN },
      { address: addr(POOL), amountAtoms: 1_000 * ATOMS_PER_ZYN }
    ]
  } as GenesisConfig;
}

function transfer(g: GenesisConfig, sender: number, nonce: number, feeAtoms = 0) {
  return createTransfer({
    chainId: g.chainId, nonce, sender: addr(sender), receiver: addr(SINK),
    amountAtoms: 1, feeAtoms, timestampMs: g.timestampMs + 1
  }, key(sender), pub(sender), 1);
}

async function withService(
  chainId: string,
  options: NodeServiceOptions,
  run: (service: NodeService, g: GenesisConfig) => Promise<void> | void
): Promise<void> {
  const g = genesis(chainId);
  const directory = await mkdtemp(join(tmpdir(), "zyron-future-cap-"));
  try {
    const store = await ChainStore.open(g, directory);
    await run(new NodeService(store, undefined, undefined, options), g);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("FUTURE-CAP: defaults are 16 parked txs per address and a 10 minute TTL", () => {
  assert.equal(DEFAULT_MEMPOOL_MAX_FUTURE_NONCE_PER_SENDER, 16);
  assert.equal(DEFAULT_MEMPOOL_PARKED_TX_TTL_MS, 10 * 60_000);
});

test("FUTURE-CAP: the 17th future-nonce tx of one address is rejected; other addresses and ready txs are unaffected", async () => {
  await withService("zyron-future-cap-1", {}, (service, g) => {
    // Alice: nonce 1 missing, nonces 2..17 parked (16), 18 refused.
    for (let nonce = 2; nonce <= 17; nonce += 1) service.submitTransaction(transfer(g, ALICE, nonce));
    assert.throws(
      () => service.submitTransaction(transfer(g, ALICE, 18)),
      /Too many future-nonce transactions for sender \(limit 16\)/
    );
    // Bob is not affected by Alice's parked transactions.
    for (let nonce = 2; nonce <= 17; nonce += 1) service.submitTransaction(transfer(g, BOB, nonce));
    // Carol's contiguous (ready) chain is not counted as parked.
    for (let nonce = 1; nonce <= 30; nonce += 1) service.submitTransaction(transfer(g, CAROL, nonce));
    assert.equal(service.mempool.size, 16 + 16 + 30);
    // Filling Alice's gap promotes her parked txs; she can park again.
    service.submitTransaction(transfer(g, ALICE, 1));
    service.submitTransaction(transfer(g, ALICE, 19));
  });
});

test("FUTURE-CAP: the cap is configurable", async () => {
  await withService("zyron-future-cap-2", { mempoolMaxFutureNoncePerSender: 2 }, (service, g) => {
    service.submitTransaction(transfer(g, ALICE, 2));
    service.submitTransaction(transfer(g, ALICE, 3));
    assert.throws(() => service.submitTransaction(transfer(g, ALICE, 5)), /limit 2/);
  });
  assert.throws(() => new NodeService({} as ChainStore, undefined, undefined, { mempoolMaxFutureNoncePerSender: 0 }), /future-nonce/);
  assert.throws(() => new NodeService({} as ChainStore, undefined, undefined, { mempoolParkedTxTtlMs: 0 }), /TTL/);
});

test("FUTURE-CAP: parked txs are evicted after the TTL; ready txs stay", async () => {
  let now = 1_000_000;
  await withService("zyron-future-cap-3", { mempoolParkedTxTtlMs: 60_000, nowMs: () => now }, (service, g) => {
    const ready = transfer(g, BOB, 1);
    service.submitTransaction(ready);
    const parked = transfer(g, ALICE, 4);
    service.submitTransaction(parked);
    now += 59_999;
    assert.equal(service.evictExpiredParkedTransactions(), 0);
    assert.ok(service.mempool.has(parked.txid));
    now += 1;
    assert.equal(service.evictExpiredParkedTransactions(), 1);
    assert.equal(service.mempool.has(parked.txid), false);
    assert.ok(service.mempool.has(ready.txid));
    // Ready txs are never TTL-evicted by this policy.
    now += 10 * 60_000;
    assert.equal(service.evictExpiredParkedTransactions(), 0);
    assert.ok(service.mempool.has(ready.txid));
  });
});

test("FUTURE-CAP: a parked tx promoted when its gap fills before the TTL is not evicted", async () => {
  let now = 5_000_000;
  await withService("zyron-future-cap-4", { mempoolParkedTxTtlMs: 60_000, nowMs: () => now }, (service, g) => {
    const parked = transfer(g, ALICE, 2);
    service.submitTransaction(parked);
    now += 30_000;
    service.submitTransaction(transfer(g, ALICE, 1));
    now += 10 * 60_000;
    assert.equal(service.evictExpiredParkedTransactions(), 0);
    assert.ok(service.mempool.has(parked.txid));
  });
});

test("FUTURE-CAP: Red Team PoC (gap nonce parks, resubmit says already in mempool) is neutralized", async () => {
  let now = 9_000_000;
  await withService("zyron-future-cap-5", { nowMs: () => now }, (service, g) => {
    // Attacker parks as many gap-nonce txs as possible (was ~63 per address).
    let accepted = 0;
    for (let nonce = 2; nonce <= 64; nonce += 1) {
      try {
        service.submitTransaction(transfer(g, ALICE, nonce));
        accepted += 1;
      } catch (error) {
        assert.match(String(error), /Too many future-nonce transactions/);
      }
    }
    assert.equal(accepted, DEFAULT_MEMPOOL_MAX_FUTURE_NONCE_PER_SENDER);
    // After the default TTL, every parked tx is gone (also via the admission path).
    now += DEFAULT_MEMPOOL_PARKED_TX_TTL_MS;
    const fresh = transfer(g, BOB, 1);
    service.submitTransaction(fresh);
    assert.equal(service.mempool.size, 1);
    // A resubmitted gap-nonce tx is admitted again rather than reported as already pending.
    service.submitTransaction(transfer(g, ALICE, 2));
  });
});
