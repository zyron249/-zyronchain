import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { failureBackoffMs, PeerReputationStore } from "../src/peer-reputation.js";

test("peer failure backoff grows exponentially and is bounded", () => {
  assert.equal(failureBackoffMs(1), 30_000);
  assert.equal(failureBackoffMs(2), 60_000);
  assert.equal(failureBackoffMs(3), 120_000);
  assert.equal(failureBackoffMs(32), 30 * 60_000);
  assert.throws(() => failureBackoffMs(0), /Invalid peer failure count/);
});

test("peer reputation survives restart and successful recovery clears backoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-reputation-"));
  const peer = "https://validator-a.example:9137";
  const now = 1_800_000_000_000;
  try {
    const store = await PeerReputationStore.open(directory);
    assert.equal(await store.recordFailure(peer, now), 30_000);
    assert.equal(await store.recordFailure(peer, now + 30_000), 60_000);

    const reopened = await PeerReputationStore.open(directory);
    assert.equal(reopened.failureCount(peer), 2);
    assert.equal(reopened.isAvailable(peer, now + 89_999), false);
    assert.equal(reopened.isAvailable(peer, now + 90_000), true);

    await reopened.recordSuccess(peer, now + 90_000);
    const recovered = await PeerReputationStore.open(directory);
    assert.equal(recovered.failureCount(peer), 0);
    assert.equal(recovered.isAvailable(peer, now + 90_000), true);
    assert.equal(await recovered.recordFailure(peer, now + 90_001), 30_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer reputation fails closed on malformed durable state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-reputation-corrupt-"));
  try {
    await writeFile(join(directory, "peer-reputation.json"), '{"version":1,"peers":[{"endpoint":"https://evil.example","consecutiveFailures":-1}]}\n');
    await assert.rejects(() => PeerReputationStore.open(directory), /Corrupt peer reputation store/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
