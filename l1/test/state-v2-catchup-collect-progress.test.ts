// Codex review on #1060 (P2, at 039ff38): the batched State-v2 catch-up still
// built the full list of node records (state.nodeRecords() traverses and copies
// the whole reachable tree) synchronously before its first bounded write,
// progress callback or event-loop yield. The same held for two more whole-tree
// steps of the catch-up: the check that each semantic key is committed by the
// target root, and the final semantic-index completeness check. On a large
// enough tree any of these alone could outlast the open-testnet boot liveness
// window while health checks go unanswered.
//
// Every step of a catch-up must be bounded: no event-loop turn and no gap
// between progress callbacks may cover more than a fraction of the tree. The
// root pointer is still published last, so an interrupted catch-up keeps the
// previous root. What is stored must not change.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SparseMerkleState, type StateV2NodeRecord } from "../src/state-v2.js";
import { StateV2DiskStore } from "../src/state-v2-store.js";

const KEYS = 10_000;

function fixture(): { root: string; records: Map<string, StateV2NodeRecord>; keys: string[] } {
  let state = SparseMerkleState.empty();
  const keys: string[] = [];
  for (let i = 0; i < KEYS; i += 1) {
    const key = `account:catchup-${i}`;
    keys.push(key);
    state = state.set(key, { balanceAtoms: i, nonce: 0 });
  }
  const records = new Map<string, StateV2NodeRecord>();
  for (const record of state.nodeRecords()) records.set(record.hash, record);
  return { root: state.root(), records, keys };
}

/** A hash-referenced target state that counts every node it has to resolve. */
function countingTarget(root: string, records: Map<string, StateV2NodeRecord>): { state: SparseMerkleState; resolutions: () => number } {
  let calls = 0;
  const state = SparseMerkleState.fromNodeResolver(root, (hash) => {
    calls += 1;
    const record = records.get(hash);
    return record ? structuredClone(record) : undefined;
  });
  return { state, resolutions: () => calls };
}

test("a State-v2 catch-up resolves only a bounded part of the tree per event-loop turn and per progress batch", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-catchup-collect-"));
  try {
    const { root, records, keys } = fixture();
    const nodes = records.size;
    assert.ok(nodes >= 16_000, `fixture tree too small (${nodes} nodes)`);
    // A quarter of the tree: the old code resolved the whole tree in one step.
    const bound = Math.floor(nodes / 4);
    const store = await StateV2DiskStore.open(directory);
    const target = countingTarget(root, records);

    let maxPerTurn = 0;
    let lastTurn = target.resolutions();
    let done = false;
    const ticker = (): void => {
      const now = target.resolutions();
      maxPerTurn = Math.max(maxPerTurn, now - lastTurn);
      lastTurn = now;
      if (!done) setImmediate(ticker);
    };
    setImmediate(ticker);

    let batches = 0;
    let maxPerBatch = 0;
    let lastBatch = target.resolutions();
    let yielded = true;
    let withoutYield = 0;
    await store.commit(target.state, keys, {
      onCatchupBatch: () => {
        const now = target.resolutions();
        maxPerBatch = Math.max(maxPerBatch, now - lastBatch);
        lastBatch = now;
        batches += 1;
        if (!yielded) withoutYield += 1;
        yielded = false;
        setImmediate(() => { yielded = true; });
      }
    });
    maxPerBatch = Math.max(maxPerBatch, target.resolutions() - lastBatch);
    done = true;
    ticker();

    assert.ok(target.resolutions() >= nodes, `the catch-up resolved only ${target.resolutions()} of ${nodes} nodes`);
    assert.ok(maxPerBatch <= bound,
      `a single catch-up step resolved ${maxPerBatch} of ${nodes} nodes before reporting progress (bound ${bound}; ${batches} batch(es))`);
    assert.ok(maxPerTurn <= bound,
      `a single event-loop turn of the catch-up resolved ${maxPerTurn} of ${nodes} nodes (bound ${bound})`);
    assert.equal(withoutYield, 0, "the catch-up did not yield to the event loop between batches");

    // What is stored is unchanged: the complete state reopens with every key.
    assert.equal(store.state().root(), root);
    const reopened = await StateV2DiskStore.open(directory);
    assert.equal(reopened.state().root(), root);
    assert.deepEqual(reopened.semanticKeyPreimages(), [...keys].sort());
    assert.deepEqual(reopened.state().get("account:catchup-1234"), { balanceAtoms: 1234, nonce: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted State-v2 catch-up keeps the previous root and a later catch-up completes", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-catchup-interrupt-"));
  try {
    const { root, records, keys } = fixture();
    const store = await StateV2DiskStore.open(directory);
    const previous = store.state().set("account:previous", { balanceAtoms: 1, nonce: 0 });
    await store.commit(previous, ["account:previous"]);
    for (const stopAt of [1, 2, 5]) {
      let calls = 0;
      await assert.rejects(
        () => store.commit(countingTarget(root, records).state, keys, {
          onCatchupBatch: () => { calls += 1; if (calls === stopAt) throw new Error(`stop at batch ${stopAt}`); }
        }),
        new RegExp(`stop at batch ${stopAt}`)
      );
      assert.equal(store.state().root(), previous.root(), `in-memory root moved after an interrupt at batch ${stopAt}`);
      const reopened = await StateV2DiskStore.open(directory);
      assert.equal(reopened.state().root(), previous.root(), `persisted root moved after an interrupt at batch ${stopAt}`);
      assert.deepEqual(reopened.state().get("account:previous"), { balanceAtoms: 1, nonce: 0 });
    }
    const resumed = await StateV2DiskStore.open(directory);
    await resumed.commit(countingTarget(root, records).state, keys);
    const complete = await StateV2DiskStore.open(directory);
    assert.equal(complete.state().root(), root);
    assert.deepEqual(complete.state().get(keys[KEYS - 1]!), { balanceAtoms: KEYS - 1, nonce: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
