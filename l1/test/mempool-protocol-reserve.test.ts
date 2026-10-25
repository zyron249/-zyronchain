// Red Team Session 1, LOW #4: a mempool full of transfers must not starve
// protocol transactions, with fixed-fee-v1 on or off. Admission policy only.
import assert from "node:assert/strict";
import test from "node:test";

import { orderPendingByFeePriority } from "../src/chain.js";
import { Mempool, type MempoolOptions } from "../src/mempool.js";
import type { Transaction, TransferTx, ValidatorSetUpdateTx } from "../src/types.js";

const chainId = "zyron-mempool-protocol-reserve-test";
const FEE = 1000;

function addr(index: number): TransferTx["sender"] {
  return `ZYN${index.toString(16).padStart(40, "0")}` as TransferTx["sender"];
}

function transfer(index: number, feeAtoms = FEE): TransferTx {
  return {
    kind: "transfer", version: 1, chainId, nonce: 1,
    sender: addr(index), receiver: addr(index + 50_000),
    amountAtoms: 1, feeAtoms, timestampMs: 1_700_100_000_000 + index,
    publicKey: "11".repeat(64), signature: "22".repeat(64),
    txid: index.toString(16).padStart(64, "0")
  };
}

function protocolTx(index: number): ValidatorSetUpdateTx {
  return {
    kind: "validator_update", version: 1, chainId, nonce: 1,
    sender: addr(900_000 + index), activationHeight: 100 + index,
    validators: [], approvals: [], feeAtoms: 0,
    timestampMs: 1_700_200_000_000 + index,
    publicKey: "33".repeat(64), signature: "44".repeat(64),
    txid: (900_000 + index).toString(16).padStart(64, "f")
  };
}

const modes: Array<[string, MempoolOptions]> = [
  ["fee-v1 off", {}],
  ["fee-v1 on", { disableFeeReplacement: true, fixedTransferFeeAtoms: FEE }]
];

function fillWithTransfers(mempool: Mempool, max: number): number {
  let admitted = 0;
  for (let i = 1; i <= max; i += 1) {
    try { mempool.add(transfer(i)); admitted += 1; } catch (error) {
      assert.match(String(error), /Mempool full/);
    }
  }
  return admitted;
}

for (const [mode, options] of modes) {
  test(`${mode}: transfers cannot use the protocol reserve`, () => {
    const mempool = new Mempool(16, 0, undefined, undefined, { ...options, protocolReserve: 4 });
    const admitted = fillWithTransfers(mempool, 40);
    assert.equal(admitted, 12, "transfers fill at most capacity minus the reserve");
    assert.throws(() => mempool.add(transfer(1000)), /Mempool full/);
  });

  test(`${mode}: full mempool of transfers still admits protocol txs`, () => {
    const mempool = new Mempool(16, 0, undefined, undefined, { ...options, protocolReserve: 2 });
    fillWithTransfers(mempool, 40);
    // Reserve slots, then eviction of the lowest-priority transfer.
    for (let i = 0; i < 6; i += 1) {
      const tx = protocolTx(i);
      mempool.add(tx);
      assert.ok(mempool.has(tx.txid), `protocol tx ${i} admitted`);
    }
    assert.equal(mempool.size, 16);
  });

  test(`${mode}: default reserve applies at default capacity (Red Team PoC)`, () => {
    // PoC: spam the default-capacity pool with transfers, then submit a protocol tx.
    const mempool = new Mempool(undefined, undefined, undefined, undefined, options);
    fillWithTransfers(mempool, 10_000);
    const tx = protocolTx(1);
    mempool.add(tx);
    assert.ok(mempool.has(tx.txid));
  });

  test(`${mode}: admitted protocol tx is selected ahead of transfers`, () => {
    const mempool = new Mempool(8, 0, undefined, undefined, { ...options, protocolReserve: 1 });
    fillWithTransfers(mempool, 20);
    const tx = protocolTx(7);
    mempool.add(tx);
    const ordered = orderPendingByFeePriority(
      mempool.values(), () => true, options.disableFeeReplacement ? { feePriority: false } : undefined
    );
    assert.equal((ordered[0] as Transaction).txid, tx.txid);
  });
}

test("protocol reserve must be smaller than capacity", () => {
  assert.throws(() => new Mempool(4, 0, undefined, undefined, { protocolReserve: 4 }), /protocol mempool reserve/);
  assert.throws(() => new Mempool(4, 0, undefined, undefined, { protocolReserve: -1 }), /protocol mempool reserve/);
});

test("byte reserve: transfers cannot fill the protocol byte reserve", () => {
  const one = Buffer.byteLength(JSON.stringify(transfer(1)), "utf8");
  const mempool = new Mempool(100, 0, one * 10, undefined, { protocolReserve: 0, protocolReserveBytes: one * 4 });
  const admitted = fillWithTransfers(mempool, 40);
  assert.ok(admitted <= 6, `transfers stay out of the byte reserve (admitted ${admitted})`);
  const tx = protocolTx(2);
  mempool.add(tx);
  assert.ok(mempool.has(tx.txid));
});
