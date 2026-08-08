import assert from "node:assert/strict";
import test from "node:test";

import { SparseMerkleState, verifySparseMerkleProof } from "../src/state-v2.js";

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
