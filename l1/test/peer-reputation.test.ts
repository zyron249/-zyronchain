import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("peer reputation fails closed when active endpoint penalties saturate capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-reputation-cap-"));
  const now = 1_800_000_000_000;
  try {
    const store = await PeerReputationStore.open(directory);
    const peers = Array.from({ length: 256 }, (_, index) => `https://validator-${index}.example:9137`);
    for (const peer of peers) await store.recordFailure(peer, now);

    const rotated = "https://rotated-attacker.example:9137";
    assert.equal(store.isAvailable(rotated, now), false);
    await store.recordFailure(rotated, now);
    assert.equal(store.isAvailable(rotated, now), false);
    assert.equal(store.isAvailable(peers[0]!, now), false);

    const snapshot = JSON.parse(await readFile(join(directory, "peer-reputation.json"), "utf8")) as { peers: unknown[] };
    assert.equal(snapshot.peers.length, 256);

    const expiry = now + 30_000;
    assert.equal(store.isAvailable(rotated, expiry), true);
    await store.recordFailure(rotated, expiry);
    assert.equal(store.isAvailable(rotated, expiry), false);
    const reopened = await PeerReputationStore.open(directory);
    assert.equal(reopened.failureCount(rotated), 1);
    const reopenedSnapshot = JSON.parse(await readFile(join(directory, "peer-reputation.json"), "utf8")) as { peers: unknown[] };
    assert.equal(reopenedSnapshot.peers.length, 256);
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
