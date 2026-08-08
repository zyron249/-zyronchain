import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import { classifyNativePeerFailure, NativePeerReputationStore } from "../src/p2p-reputation.js";

const peerId = peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from("01".padStart(64, "0"), "hex"))).toString();

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
