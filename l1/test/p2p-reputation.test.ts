import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import {
  classifyNativePeerFailure,
  MAX_NATIVE_REPUTATION_SNAPSHOT_BYTES,
  nativePeerReputationDirectorySyncSupported,
  NativePeerReputationStore
} from "../src/p2p-reputation.js";

const peerId = peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from("01".padStart(64, "0"), "hex"))).toString();

function peerIdForIndex(index: number): string {
  const seed = Buffer.alloc(32);
  seed.writeUInt32BE(index, 28);
  return peerIdFromPrivateKey(privateKeyFromRaw(seed)).toString();
}

test("native reputation persists transient backoff and protocol temporary bans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-native-reputation-"));
  const now = 1_900_000_000_000;
  try {
    const store = await NativePeerReputationStore.open(directory);
    assert.equal(await store.recordFailure(peerId, "transient", now), 30_000);
    assert.equal(store.isAvailable(peerId, now + 29_999), false);
    assert.equal(await store.recordFailure(peerId, "protocol", now + 30_000), 30 * 60_000);
    const reopened = await NativePeerReputationStore.open(directory);
    assert.equal(reopened.failureCount(peerId), 2);
    assert.equal(reopened.isAvailable(peerId, now + 30_000 + (30 * 60_000) - 1), false);
    await reopened.recordSuccess(peerId, now + 30_000 + (30 * 60_000));
    assert.equal(reopened.failureCount(peerId), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native reputation never evicts tracked identities when capacity is saturated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-native-reputation-cap-"));
  const now = 1_900_000_000_000;
  try {
    const store = await NativePeerReputationStore.open(directory);
    const penalized = Array.from({ length: 256 }, (_, index) => peerIdForIndex(index + 1));
    for (const candidate of penalized) await store.recordFailure(candidate, "protocol", now);
    const rotated = peerIdForIndex(10_000);
    assert.equal(store.isAvailable(rotated, now), false);
    await store.recordFailure(rotated, "protocol", now);
    const expiry = now + (30 * 60_000);
    assert.equal(store.isAvailable(penalized[0]!, expiry), true);
    assert.equal(store.isAvailable(rotated, expiry), false);
    await store.recordFailure(rotated, "protocol", expiry);
    await store.recordSuccess(rotated, expiry);
    const reopened = await NativePeerReputationStore.open(directory);
    assert.equal(reopened.failureCount(rotated), 0);
    assert.equal(reopened.failureCount(penalized[0]!), 1);
    assert.equal(reopened.isAvailable(rotated, expiry), false);
    const snapshot = JSON.parse(await readFile(join(directory, "native-peer-reputation.json"), "utf8")) as { peers: Array<{ peerId: string }> };
    assert.equal(snapshot.peers.length, 256);
    assert.equal(snapshot.peers.some((entry) => entry.peerId === rotated), false);
    assert.equal(snapshot.peers.some((entry) => entry.peerId === penalized[0]), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native reputation classifies transport failure separately and fails closed on corrupt disk state", async () => {
  assert.equal(classifyNativePeerFailure(new Error("dial timeout")), "transient");
  assert.equal(classifyNativePeerFailure(new Error("Native sync peer advertised a false tip")), "protocol");
  const directory = await mkdtemp(join(tmpdir(), "zyron-native-reputation-corrupt-"));
  try {
    await writeFile(join(directory, "native-peer-reputation.json"), '{"version":1,"peers":[{"peerId":"bad"}]}\n');
    await assert.rejects(() => NativePeerReputationStore.open(directory), /Corrupt native peer reputation store/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native reputation rejects oversized snapshot before JSON materialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-native-reputation-oversized-"));
  try {
    await writeFile(join(directory, "native-peer-reputation.json"), Buffer.alloc(MAX_NATIVE_REPUTATION_SNAPSHOT_BYTES + 1, 0x61));
    await assert.rejects(() => NativePeerReputationStore.open(directory), /Corrupt native peer reputation store/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native reputation directory sync is skipped only on Windows", () => {
  assert.equal(nativePeerReputationDirectorySyncSupported("win32"), false);
  assert.equal(nativePeerReputationDirectorySyncSupported("linux"), true);
  assert.equal(nativePeerReputationDirectorySyncSupported("darwin"), true);
});
