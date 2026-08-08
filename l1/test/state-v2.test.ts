import assert from "node:assert/strict";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  accountKey,
  reconstructStateV2PortableView,
  SparseMerkleState,
  stateV2FromLedgerSnapshot,
  stateV2KeyPreimages,
  verifySparseMerkleProof
} from "../src/state-v2.js";

test("State v2 root is deterministic regardless of insertion order", () => {
  const entries = [
    ["account:ZYNaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { balanceAtoms: 10, nonce: 1 }],
    ["account:ZYNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", { balanceAtoms: 20, nonce: 2 }],
    ["activity-epoch:7", { settled: true }]
  ] as const;
  let forward = SparseMerkleState.empty();
  for (const [key, value] of entries) forward = forward.set(key, value);
  let reverse = SparseMerkleState.empty();
  for (const [key, value] of [...entries].reverse()) reverse = reverse.set(key, value);
  assert.equal(forward.root(), reverse.root());
});

test("State v2 migration root commits validator and protocol schedules", () => {
  const ledger = { accounts: [], settledActivityEpochs: [] };
  const first = stateV2FromLedgerSnapshot(ledger, {
    validatorSchedule: [{
      activationHeight: 0,
      validators: [{ address: "ZYNvalidator-a", publicKey: `02${"11".repeat(32)}` }]
    }],
    protocolSchedule: [{ activationHeight: 0, protocolVersion: 1 }]
  });
  const changedValidator = stateV2FromLedgerSnapshot(ledger, {
    validatorSchedule: [{
      activationHeight: 0,
      validators: [{ address: "ZYNvalidator-b", publicKey: `02${"22".repeat(32)}` }]
    }],
    protocolSchedule: [{ activationHeight: 0, protocolVersion: 1 }]
  });
  const changedProtocol = stateV2FromLedgerSnapshot(ledger, {
    validatorSchedule: [{
      activationHeight: 0,
      validators: [{ address: "ZYNvalidator-a", publicKey: `02${"11".repeat(32)}` }]
    }],
    protocolSchedule: [
      { activationHeight: 0, protocolVersion: 1 },
      { activationHeight: 101, protocolVersion: 2 }
    ]
  });
  assert.notEqual(first.root(), changedValidator.root());
  assert.notEqual(first.root(), changedProtocol.root());
});

test("State v2 updates are copy-on-write and preserve the finalized root", () => {
  const finalized = SparseMerkleState.empty().set("account:alice", { balanceAtoms: 100, nonce: 0 });
  const finalizedRoot = finalized.root();
  const candidate = finalized.set("account:alice", { balanceAtoms: 75, nonce: 1 });
  assert.equal(finalized.root(), finalizedRoot);
  assert.notEqual(candidate.root(), finalizedRoot);
});

test("State v2 membership and non-membership proofs verify against the root", () => {
  const alice = { balanceAtoms: 100, nonce: 2 };
  const state = SparseMerkleState.empty()
    .set("account:alice", alice)
    .set("account:bob", { balanceAtoms: 50, nonce: 1 });
  assert.equal(state.root(), "0645f662569494b33185d2d206b5cd50e9d0fa96dcda9a5f2b8dea878df1aa0c");
  const member = state.prove("account:alice");
  const absent = state.prove("account:carol");
  assert.equal(member.siblings.length, 256);
  assert.equal(verifySparseMerkleProof(state.root(), "account:alice", alice, member), true);
  assert.equal(verifySparseMerkleProof(state.root(), "account:carol", null, absent), true);
  assert.equal(verifySparseMerkleProof(state.root(), "account:alice", { balanceAtoms: 101, nonce: 2 }, member), false);
});

test("State v2 rejects tampered proof paths", () => {
  const value = { balanceAtoms: 42, nonce: 3 };
  const state = SparseMerkleState.empty().set("account:alice", value);
  const proof = state.prove("account:alice");
  const tampered = structuredClone(proof);
  tampered.siblings[100] = "00".repeat(32);
  assert.equal(verifySparseMerkleProof(state.root(), "account:alice", value, tampered), false);
});

test("State v2 semantic-key preimages reconstruct the exact authenticated ledger and governance view", () => {
  const validatorPublic = publicKeyFromPrivate("21".padStart(64, "0"));
  const validator = addressFromPublicKey(validatorPublic);
  const accountPublic = publicKeyFromPrivate("22".padStart(64, "0"));
  const account = addressFromPublicKey(accountPublic);
  const ledger = {
    accounts: [{ address: account, balanceAtoms: 123_456, nonce: 7 }],
    settledActivityEpochs: [3, 9]
  };
  const governance = {
    validatorSchedule: [{ activationHeight: 0, validators: [{ address: validator, publicKey: validatorPublic }] }],
    protocolSchedule: [
      { activationHeight: 0, protocolVersion: 1 },
      { activationHeight: 101, protocolVersion: 2 }
    ]
  };
  const state = stateV2FromLedgerSnapshot(ledger, governance);
  const keys = stateV2KeyPreimages(ledger, governance);
  const reconstructed = reconstructStateV2PortableView(state, keys);
  assert.deepEqual(reconstructed.ledger, ledger);
  assert.deepEqual(reconstructed.governance, governance);
  assert.equal(stateV2FromLedgerSnapshot(reconstructed.ledger, reconstructed.governance).root(), state.root());
});

test("State v2 portable reconstruction fails closed on missing, substituted, duplicate and unknown key preimages", () => {
  const validatorPublic = publicKeyFromPrivate("23".padStart(64, "0"));
  const validator = addressFromPublicKey(validatorPublic);
  const account = addressFromPublicKey(publicKeyFromPrivate("24".padStart(64, "0")));
  const ledger = { accounts: [{ address: account, balanceAtoms: 5, nonce: 0 }], settledActivityEpochs: [4] };
  const governance = {
    validatorSchedule: [{ activationHeight: 0, validators: [{ address: validator, publicKey: validatorPublic }] }],
    protocolSchedule: [{ activationHeight: 0, protocolVersion: 1 }]
  };
  const state = stateV2FromLedgerSnapshot(ledger, governance);
  const keys = stateV2KeyPreimages(ledger, governance);

  assert.throws(() => reconstructStateV2PortableView(state, keys.slice(1)), /count mismatch/);
  const duplicate = [...keys];
  duplicate[1] = duplicate[0]!;
  assert.throws(() => reconstructStateV2PortableView(state, duplicate), /Duplicate|not committed/);
  const substituted = [...keys];
  substituted[substituted.indexOf(accountKey(account))] = `${accountKey(account)}x`;
  assert.throws(() => reconstructStateV2PortableView(state, substituted), /not committed/);

  const withUnknown = state.set("unknown:consensus-key", { attacker: true });
  assert.throws(
    () => reconstructStateV2PortableView(withUnknown, [...keys, "unknown:consensus-key"]),
    /Unknown State v2 semantic key/
  );
  const malformed = state.set(accountKey(account), { balanceAtoms: -1, nonce: 0 });
  assert.throws(() => reconstructStateV2PortableView(malformed, keys), /Invalid State v2 account value/);
});
