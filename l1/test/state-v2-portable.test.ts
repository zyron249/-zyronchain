import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  createStateV2PortableBundle,
  validateStateV2PortableBundle
} from "../src/state-v2-portable.js";
import { SparseMerkleState, stateV2FromLedgerSnapshot } from "../src/state-v2.js";

function fixture() {
  const validatorPublic = publicKeyFromPrivate("31".padStart(64, "0"));
  const validator = addressFromPublicKey(validatorPublic);
  const alice = addressFromPublicKey(publicKeyFromPrivate("32".padStart(64, "0")));
  const bob = addressFromPublicKey(publicKeyFromPrivate("33".padStart(64, "0")));
  const ledger = {
    accounts: [
      { address: alice, balanceAtoms: 90, nonce: 2 },
      { address: bob, balanceAtoms: 10, nonce: 0 }
    ].sort((a, b) => a.address.localeCompare(b.address)),
    settledActivityEpochs: [2, 8]
  };
  const governance = {
    validatorSchedule: [{ activationHeight: 0, validators: [{ address: validator, publicKey: validatorPublic }] }],
    protocolSchedule: [
      { activationHeight: 0, protocolVersion: 1 },
      { activationHeight: 101, protocolVersion: 2 }
    ]
  };
  const state = stateV2FromLedgerSnapshot(ledger, governance);
  return { ledger, governance, state };
}

test("portable State v2 bundle reconstructs only the complete root-reachable authenticated state", () => {
  const { ledger, governance, state } = fixture();
  const bundle = createStateV2PortableBundle(state, ledger, governance);
  const validated = validateStateV2PortableBundle(bundle, state.root());
  assert.equal(validated.state.root(), state.root());
  assert.deepEqual(validated.view.ledger, ledger);
  assert.deepEqual(validated.view.governance, governance);
  assert.equal(validated.bundle.records.length, state.nodeRecords().length);
});

test("portable State v2 bundle rejects missing, duplicate, unreachable and corrupt node records", () => {
  const { ledger, governance, state } = fixture();
  const bundle = createStateV2PortableBundle(state, ledger, governance);

  const missing = structuredClone(bundle);
  missing.records.shift();
  assert.throws(() => validateStateV2PortableBundle(missing, state.root()), /Missing State v2 node record/);

  const duplicate = structuredClone(bundle);
  duplicate.records.push(structuredClone(duplicate.records[0]!));
  assert.throws(() => validateStateV2PortableBundle(duplicate, state.root()), /Duplicate State v2 node record/);

  const extraState = SparseMerkleState.empty().set("account:unreachable", { balanceAtoms: 1, nonce: 0 });
  const unreachable = structuredClone(bundle);
  unreachable.records.push(structuredClone(extraState.nodeRecords()[0]!));
  assert.throws(() => validateStateV2PortableBundle(unreachable, state.root()), /unreachable nodes/);

  const corrupt = structuredClone(bundle);
  const leaf = corrupt.records.find((record) => record.kind === "leaf");
  assert.ok(leaf?.kind === "leaf");
  leaf.valueJson = "{}";
  assert.throws(() => validateStateV2PortableBundle(corrupt, state.root()), /leaf value|node hash mismatch/i);
});

test("portable State v2 bundle rejects anchor, schema and semantic-preimage substitution", () => {
  const { ledger, governance, state } = fixture();
  const bundle = createStateV2PortableBundle(state, ledger, governance);
  assert.throws(() => validateStateV2PortableBundle(bundle, "00".repeat(32)), /Invalid portable State v2 bundle/);

  const missingKey = structuredClone(bundle);
  missingKey.keyPreimages.pop();
  assert.throws(() => validateStateV2PortableBundle(missingKey, state.root()), /count mismatch/);

  const unknownField = { ...structuredClone(bundle), attacker: true };
  assert.throws(() => validateStateV2PortableBundle(unknownField, state.root()), /fields/);

  const changedRoot = structuredClone(bundle);
  changedRoot.root = "11".repeat(32);
  assert.throws(() => validateStateV2PortableBundle(changedRoot, state.root()), /Invalid portable State v2 bundle/);
});
