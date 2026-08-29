import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  failureBackoffMs,
  httpPeerReputationDirectorySyncSupported,
  MAX_PEER_REPUTATION_ENDPOINT_BYTES,
  MAX_PEER_REPUTATION_SNAPSHOT_BYTES,
  PeerReputationStore
} from "../src/peer-reputation.js";

test("peer failure backoff grows exponentially and is bounded", () => {
  assert.equal(failureBackoffMs(1), 30_000);
  assert.equal(failureBackoffMs(2), 60_000);
  assert.equal(failureBackoffMs(3), 120_000);
  assert.equal(failureBackoffMs(32), 30 * 60_000);
  assert.throws(() => failureBackoffMs(0), /Invalid peer failure count/);
});

test("HTTP peer reputation directory fsync is required only where Node supports it", () => {
  assert.equal(httpPeerReputationDirectorySyncSupported("linux"), true);
  assert.equal(httpPeerReputationDirectorySyncSupported("darwin"), true);
  assert.equal(httpPeerReputationDirectorySyncSupported("freebsd"), true);
  assert.equal(httpPeerReputationDirectorySyncSupported("win32"), false);
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

test("peer reputation never evicts tracked identities when capacity is saturated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-reputation-cap-"));
  const now = 1_800_000_000_000;
  try {
    const store = await PeerReputationStore.open(directory);
    const peers = Array.from({ length: 256 }, (_, index) => `https://validator-${index}.example:9137`);
    for (const peer of peers) await store.recordFailure(peer, now);
    const rotated = "https://rotated-attacker.example:9137";
    assert.equal(store.isAvailable(rotated, now), false);
    await store.recordFailure(rotated, now);
    const expiry = now + 30_000;
    assert.equal(store.isAvailable(peers[0]!, expiry), true);
    assert.equal(store.isAvailable(rotated, expiry), false);
    await store.recordFailure(rotated, expiry);
    await store.recordSuccess(rotated, expiry);
    const reopened = await PeerReputationStore.open(directory);
    assert.equal(reopened.failureCount(rotated), 0);
    assert.equal(reopened.failureCount(peers[0]!), 1);
    assert.equal(reopened.isAvailable(rotated, expiry), false);
    const snapshot = JSON.parse(await readFile(join(directory, "peer-reputation.json"), "utf8")) as { peers: Array<{ endpoint: string }> };
    assert.equal(snapshot.peers.length, 256);
    assert.equal(snapshot.peers.some((entry) => entry.endpoint === rotated), false);
    assert.equal(snapshot.peers.some((entry) => entry.endpoint === peers[0]), true);
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

test("peer reputation rejects oversized snapshot before JSON materialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-reputation-oversized-"));
  try {
    await writeFile(join(directory, "peer-reputation.json"), Buffer.alloc(MAX_PEER_REPUTATION_SNAPSHOT_BYTES + 1, 0x61));
    await assert.rejects(() => PeerReputationStore.open(directory), /Corrupt peer reputation store/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer reputation bounds normalized endpoint bytes before persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-reputation-endpoint-"));
  try {
    const store = await PeerReputationStore.open(directory);
    const oversized = `https://validator.example/${"a".repeat(MAX_PEER_REPUTATION_ENDPOINT_BYTES)}`;
    assert.throws(() => store.isAvailable(oversized), /endpoint exceeds byte limit/);
    await assert.rejects(() => store.recordFailure(oversized), /endpoint exceeds byte limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer reputation removes unpublished temporary state after a pre-rename persistence failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-reputation-temp-fault-"));
  try {
    const store = await PeerReputationStore.open(directory);
    await assert.rejects(
      () => store.recordFailure("https://fault-before-rename.example", 1_800_000_000_000, {
        afterTemporarySync: () => { throw new Error("injected-before-rename"); }
      }),
      /injected-before-rename/
    );
    const names = await readdir(directory);
    assert.equal(names.some((name) => name.startsWith("peer-reputation.json.tmp-")), false);
    assert.equal(names.includes("peer-reputation.json"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer reputation surfaces an ambiguous post-rename publication failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-reputation-rename-fault-"));
  const peer = "https://fault-after-rename.example";
  const now = 1_800_000_000_000;
  try {
    const store = await PeerReputationStore.open(directory);
    await assert.rejects(
      () => store.recordFailure(peer, now, {
        afterRename: () => { throw new Error("injected-after-rename"); }
      }),
      /injected-after-rename/
    );
    const reopened = await PeerReputationStore.open(directory);
    assert.equal(reopened.failureCount(peer), 1);
    assert.equal(reopened.isAvailable(peer, now), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer reputation completes directory durability before reporting successful publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-reputation-dir-sync-"));
  const peer = "https://directory-sync.example";
  const now = 1_800_000_000_000;
  let reachedDirectorySync = false;
  try {
    const store = await PeerReputationStore.open(directory);
    await store.recordFailure(peer, now, {
      afterDirectorySync: () => { reachedDirectorySync = true; }
    });
    assert.equal(reachedDirectorySync, httpPeerReputationDirectorySyncSupported());
    const reopened = await PeerReputationStore.open(directory);
    assert.equal(reopened.failureCount(peer), 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
