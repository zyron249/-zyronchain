// Follow-up to the future-nonce cap (#1131), from Security's non-blocking notes:
// 1. A same-nonce fee-bump replacement of a parked tx keeps the ORIGINAL
//    admission time, so replacements cannot extend the parked TTL.
// 2. The parked TTL option has an upper sanity bound and fails closed.
// Node mempool policy only; block validity is unchanged.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { Mempool } from "../src/mempool.js";
import {
  MAX_MEMPOOL_PARKED_TX_TTL_MS,
  NodeService,
  type NodeServiceOptions
} from "../src/node.js";
import { ChainStore } from "../src/storage.js";
import { createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type GenesisConfig } from "../src/types.js";

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 81;
const ORACLE = 82;
const POOL = 83;
const ALICE = 84;
const BOB = 85;
const SINK = 87;

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
  const directory = await mkdtemp(join(tmpdir(), "zyron-parked-followup-"));
  try {
    const store = await ChainStore.open(g, directory);
    await run(new NodeService(store, undefined, undefined, options), g);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("PARKED-FOLLOWUP: a fee-bump replacement of a parked tx keeps the original admission time", async () => {
  let now = 1_000_000;
  await withService("zyron-parked-followup-1", { mempoolParkedTxTtlMs: 60_000, nowMs: () => now }, (service, g) => {
    const first = transfer(g, ALICE, 3, 1_000);
    service.submitTransaction(first);
    now += 50_000;
    const bumped = transfer(g, ALICE, 3, 10_000);
    service.submitTransaction(bumped);
    assert.equal(service.mempool.has(first.txid), false);
    assert.ok(service.mempool.has(bumped.txid));
    // 60 s after the ORIGINAL admission the replacement expires too.
    now += 10_000;
    assert.equal(service.evictExpiredParkedTransactions(), 1);
    assert.equal(service.mempool.has(bumped.txid), false);
  });
});

test("PARKED-FOLLOWUP: repeated replacements cannot keep a parked tx alive", async () => {
  let now = 2_000_000;
  await withService("zyron-parked-followup-2", { mempoolParkedTxTtlMs: 60_000, nowMs: () => now }, (service, g) => {
    let fee = 1_000;
    let latest = transfer(g, ALICE, 5, fee);
    service.submitTransaction(latest);
    for (let i = 0; i < 5; i += 1) {
      now += 11_000;
      fee *= 2;
      latest = transfer(g, ALICE, 5, fee);
      service.submitTransaction(latest);
    }
    // 55 s elapsed; 5 more seconds reaches the original TTL.
    now += 5_000;
    assert.equal(service.evictExpiredParkedTransactions(), 1);
    assert.equal(service.mempool.has(latest.txid), false);
  });
});

test("PARKED-FOLLOWUP: replacement keeps admission order so older parked txs still expire", async () => {
  let now = 3_000_000;
  await withService("zyron-parked-followup-3", { mempoolParkedTxTtlMs: 60_000, nowMs: () => now }, (service, g) => {
    const a = transfer(g, ALICE, 3, 1_000);
    service.submitTransaction(a);
    now += 1_000;
    const b = transfer(g, BOB, 4, 1_000);
    service.submitTransaction(b);
    now += 1_000;
    const a2 = transfer(g, ALICE, 3, 5_000);
    service.submitTransaction(a2);
    now = 3_000_000 + 61_000;
    assert.equal(service.evictExpiredParkedTransactions(), 2);
    assert.equal(service.mempool.has(a2.txid), false);
    assert.equal(service.mempool.has(b.txid), false);
  });
});

test("PARKED-FOLLOWUP: Mempool.add keeps the original admission time on replacement", () => {
  const g = genesis("zyron-parked-followup-4");
  const pool = new Mempool();
  const first = transfer(g, ALICE, 1, 1_000);
  pool.add(first, 100);
  pool.add(transfer(g, ALICE, 1, 10_000), 900);
  assert.equal(pool.admittedAtOrBefore(100).length, 1);
});

test("PARKED-FOLLOWUP: the parked TTL is capped at 24 hours", async () => {
  assert.equal(MAX_MEMPOOL_PARKED_TX_TTL_MS, 24 * 60 * 60_000);
  await withService("zyron-parked-followup-5", { mempoolParkedTxTtlMs: MAX_MEMPOOL_PARKED_TX_TTL_MS }, () => {});
  for (const bad of [MAX_MEMPOOL_PARKED_TX_TTL_MS + 1, Number.MAX_SAFE_INTEGER, 0, -1, 1.5]) {
    await assert.rejects(
      withService("zyron-parked-followup-6", { mempoolParkedTxTtlMs: bad }, () => {}),
      /Mempool parked transaction TTL must be an integer from 1 to 86400000 ms/
    );
  }
});
