// R6b-1014-M1 (round-6 independent AI retest of #1014): the root-anchored
// record stream accepted any record that some accepted branch still expected,
// so a peer could reorder genuine records (for example breadth first) and grow
// the outstanding set to the width of the tree instead of its depth, while
// every hash still checked out. Records must arrive in exact reverse
// post-order, so the outstanding set stays bounded by the tree depth.
import assert from "node:assert/strict";
import test from "node:test";

import { SparseMerkleState, StateV2AnchoredRecordStream, type StateV2NodeRecord } from "../src/state-v2.js";

const TREE_DEPTH = 256;

function fixture(keys: number): { root: string; records: StateV2NodeRecord[] } {
  let state = SparseMerkleState.empty();
  for (let index = 0; index < keys; index += 1) state = state.set(`account:${index}`, { balance: String(index), nonce: 0 });
  return { root: state.root(), records: state.nodeRecords() };
}

function breadthFirst(root: string, records: readonly StateV2NodeRecord[]): StateV2NodeRecord[] {
  const byHash = new Map(records.map((record) => [record.hash, record]));
  const order: StateV2NodeRecord[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const record = byHash.get(queue.shift()!)!;
    order.push(record);
    if (record.kind === "branch") {
      if (record.rightHash) queue.push(record.rightHash);
      if (record.leftHash) queue.push(record.leftHash);
    }
  }
  return order;
}

const { root, records } = fixture(600);

test("R6b-1014-M1: honest reverse post-order is accepted and the outstanding set stays within the tree depth", () => {
  const stream = new StateV2AnchoredRecordStream(root);
  let peak = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    stream.accept(records[index]!);
    peak = Math.max(peak, stream.outstandingCount());
  }
  stream.finish(records.length);
  assert.ok(peak <= TREE_DEPTH + 1, `outstanding peak ${peak}`);
});

test("R6b-1014-M1: genuine records reordered breadth first are rejected before the outstanding set outgrows the tree depth", () => {
  const order = breadthFirst(root, records);
  assert.equal(order.length, records.length);
  const stream = new StateV2AnchoredRecordStream(root);
  let accepted = 0;
  assert.throws(() => {
    for (const record of order) {
      stream.accept(record);
      accepted += 1;
      assert.ok(stream.outstandingCount() <= TREE_DEPTH + 1, `outstanding ${stream.outstandingCount()}`);
    }
  }, /does not match the anchored state root/);
  assert.ok(accepted < order.length);
});

test("R6b-1014-M1: two sibling subtrees swapped is rejected in the record that arrives out of order", () => {
  const reversed = [...records].reverse();
  // The root's two children: honest order sends the right subtree first.
  const rootRecord = reversed[0]!;
  assert.equal(rootRecord.kind, "branch");
  const leftStart = reversed.findIndex((record) => record.hash === (rootRecord as { leftHash: string | null }).leftHash);
  assert.ok(leftStart > 1);
  const swapped = [rootRecord, ...reversed.slice(leftStart), ...reversed.slice(1, leftStart)];
  const stream = new StateV2AnchoredRecordStream(root);
  assert.throws(() => { for (const record of swapped) stream.accept(record); }, /does not match the anchored state root/);
});
