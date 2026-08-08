import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { LedgerState } from "../src/state.js";
import { applyStateV2Transaction, stateV2Balance, stateV2FromLedgerSnapshot, stateV2Nonce } from "../src/state-v2.js";
import { createTransfer } from "../src/transaction.js";
import type { GenesisConfig, TransferTx } from "../src/types.js";

test("property: randomized valid transfers preserve ledger/State-v2 semantics and deterministic replay", () => {
  const privateKeys = Array.from({ length: 8 }, (_, index) => (index + 20).toString(16).padStart(64, "0"));
  const publicKeys = privateKeys.map(publicKeyFromPrivate);
  const addresses = publicKeys.map(addressFromPublicKey);
  const genesis: GenesisConfig = {
    chainId: "zyron-state-property",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addresses[0]!, publicKey: publicKeys[0]! }],
    activityOracles: [publicKeys[1]!],
    activityPool: addresses[1]!,
    allocations: addresses.map((address) => ({ address, amountAtoms: 1_000_000 }))
  };

  const initialLedger = LedgerState.fromGenesis(genesis);
  const ledger = initialLedger.clone();
  let sparse = stateV2FromLedgerSnapshot(initialLedger.snapshot());
  const transactions: TransferTx[] = [];
  let seed = 0x8badf00d;

  for (let step = 0; step < 500; step += 1) {
    seed = next(seed);
    const senderIndex = seed % addresses.length;
    seed = next(seed);
    let receiverIndex = seed % addresses.length;
    if (receiverIndex === senderIndex) receiverIndex = (receiverIndex + 1) % addresses.length;
    const sender = addresses[senderIndex]!;
    const receiver = addresses[receiverIndex]!;
    const available = ledger.balance(sender);
    seed = next(seed);
    const feeAtoms = seed % 7;
    seed = next(seed);
    const amountAtoms = 1 + (seed % Math.min(5_000, available - feeAtoms - 1));
    const tx = createTransfer({
      chainId: genesis.chainId,
      nonce: ledger.nonce(sender) + 1,
      sender,
      receiver,
      amountAtoms,
      feeAtoms,
      timestampMs: genesis.timestampMs + step + 1
    }, privateKeys[senderIndex]!, publicKeys[senderIndex]!);

    ledger.apply(tx, genesis.activityPool);
    sparse = applyStateV2Transaction(sparse, tx, genesis.activityPool);
    transactions.push(tx);

    for (const address of addresses) {
      assert.equal(stateV2Balance(sparse, address), ledger.balance(address));
      assert.equal(stateV2Nonce(sparse, address), ledger.nonce(address));
    }
    const legacySupply = ledger.snapshot().accounts.reduce((sum, account) => sum + account.balanceAtoms, 0);
    const sparseSupply = addresses.reduce((sum, address) => sum + stateV2Balance(sparse, address), 0);
    assert.equal(sparseSupply, legacySupply);
  }

  let replay = stateV2FromLedgerSnapshot(initialLedger.snapshot());
  for (const tx of transactions) replay = applyStateV2Transaction(replay, tx, genesis.activityPool);
  assert.equal(replay.root(), sparse.root());
});

function next(value: number): number {
  return ((value * 1664525) + 1013904223) >>> 0;
}
