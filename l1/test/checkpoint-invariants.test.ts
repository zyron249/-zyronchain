import assert from "node:assert/strict";
import test from "node:test";

import { createGenesisBlock } from "../src/block.js";
import { validateTrustedCheckpointSemantics } from "../src/checkpoint-invariants.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { MINING_TRACKER_ADDRESS } from "../src/mining.js";
import { LedgerState } from "../src/state.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivateKey = "61".padStart(64, "0");
const validatorPublicKey = publicKeyFromPrivate(validatorPrivateKey);
const validatorAddress = addressFromPublicKey(validatorPublicKey);
const oraclePublicKey = publicKeyFromPrivate("62".padStart(64, "0"));

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-checkpoint-invariants",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validatorAddress, publicKey: validatorPublicKey }],
    activityOracles: [oraclePublicKey],
    activityPool: validatorAddress,
    allocations: [{ address: validatorAddress, amountAtoms: 100 }]
  };
}

function validInput() {
  const config = genesis();
  const state = LedgerState.fromGenesis(config);
  return {
    tip: createGenesisBlock(config, state.root()),
    activeProtocolVersion: 1,
    state,
    genesisSupplyAtoms: 100
  };
}

test("trusted checkpoint semantics bind tip protocol version and transaction body commitment", () => {
  const input = validInput();
  assert.doesNotThrow(() => validateTrustedCheckpointSemantics(input));

  assert.throws(
    () => validateTrustedCheckpointSemantics({
      ...input,
      tip: { ...input.tip, header: { ...input.tip.header, version: 2 } }
    }),
    /tip protocol version mismatch/
  );

  assert.throws(
    () => validateTrustedCheckpointSemantics({
      ...input,
      tip: { ...input.tip, header: { ...input.tip.header, transactionRoot: "11".repeat(32) } }
    }),
    /transaction Merkle root mismatch/
  );
});

test("trusted checkpoint semantics reject mining tracker balance and impossible historical supply", () => {
  const input = validInput();
  const snapshot = input.state.snapshot();

  const trackerFunded = LedgerState.fromSnapshot({
    ...snapshot,
    accounts: [
      ...snapshot.accounts,
      { address: MINING_TRACKER_ADDRESS, balanceAtoms: 1, nonce: 0 }
    ]
  });
  assert.throws(
    () => validateTrustedCheckpointSemantics({ ...input, state: trackerFunded }),
    /mining tracker balance must remain zero/
  );

  const inflated = LedgerState.fromSnapshot({
    ...snapshot,
    accounts: snapshot.accounts.map((account) =>
      account.address === validatorAddress ? { ...account, balanceAtoms: 101 } : account)
  });
  assert.throws(
    () => validateTrustedCheckpointSemantics({ ...input, state: inflated }),
    /current supply exceeds historical issuance/
  );
});

test("trusted checkpoint semantics reject unreachable mining counters but allow burned supply", () => {
  const input = validInput();
  const snapshot = input.state.snapshot();
  const unreachableCounter = LedgerState.fromSnapshot({
    ...snapshot,
    accounts: [
      ...snapshot.accounts,
      { address: MINING_TRACKER_ADDRESS, balanceAtoms: 0, nonce: 1_000_000_000 }
    ]
  });
  assert.throws(
    () => validateTrustedCheckpointSemantics({ ...input, state: unreachableCounter }),
    /claim counter exceeds reachable issuance history/
  );

  const burned = LedgerState.fromSnapshot({
    ...snapshot,
    accounts: snapshot.accounts.map((account) =>
      account.address === validatorAddress ? { ...account, balanceAtoms: 50 } : account)
  });
  assert.doesNotThrow(() => validateTrustedCheckpointSemantics({ ...input, state: burned }));
});
