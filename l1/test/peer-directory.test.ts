import assert from "node:assert/strict";
import test from "node:test";

import { generatePrivateKey, publicKeyFromPrivate } from "../src/crypto.js";
import { PeerDirectory } from "../src/peer-directory.js";
import { createSignedPeerRecord, nodeIdFromPublicKey, type NodeIdentity } from "../src/peer-identity.js";

const expected = {
  chainId: "zyron-directory-test",
  genesisHash: "ab".repeat(32)
};

function identity(): NodeIdentity {
  const privateKey = generatePrivateKey();
  const publicKey = publicKeyFromPrivate(privateKey);
  return { version: 1, privateKey, publicKey, nodeId: nodeIdFromPublicKey(publicKey) };
}

function record(node: NodeIdentity, issuedAtMs: number, endpoint: string) {
  return createSignedPeerRecord(node, {
    ...expected,
    endpoints: [endpoint],
    issuedAtMs,
    expiresAtMs: issuedAtMs + 60_000
  });
}

test("peer directory admits only verified records and deterministically replaces newer identity records", () => {
  const now = 1_800_000_000_000;
  const first = identity();
  const second = identity();
  const directory = new PeerDirectory(expected, { maxRecords: 2, maxResponseRecords: 2 });
  const firstRecord = record(first, now, "https://one.example:9137");
  const secondRecord = record(second, now + 1, "https://two.example:9137");

  assert.equal(directory.admit(firstRecord, now + 2), true);
  assert.equal(directory.admit(firstRecord, now + 2), false);
  assert.equal(directory.admit(secondRecord, now + 2), true);
  assert.deepEqual(directory.list(2, now + 2).map((item) => item.nodeId), [second.nodeId, first.nodeId]);

  const refreshed = record(first, now + 3, "https://one-new.example:9137");
  assert.equal(directory.admit(refreshed, now + 4), true);
  assert.deepEqual(directory.list(2, now + 4).find((item) => item.nodeId === first.nodeId)?.endpoints, [
    "https://one-new.example:9137"
  ]);
});

test("peer directory fails closed at capacity, bounds responses and rejects tampered records", () => {
  const now = 1_800_000_100_000;
  const directory = new PeerDirectory(expected, { maxRecords: 2, maxResponseRecords: 1 });
  const nodes = [identity(), identity(), identity()];
  directory.admit(record(nodes[0]!, now, "https://one.example:9137"), now + 1);
  directory.admit(record(nodes[1]!, now + 1, "https://two.example:9137"), now + 2);

  assert.throws(
    () => directory.admit(record(nodes[2]!, now + 2, "https://three.example:9137"), now + 3),
    /capacity reached/
  );
  assert.equal(directory.list(1, now + 3).length, 1);
  assert.throws(() => directory.list(2, now + 3), /Invalid peer discovery response limit/);

  const tampered = structuredClone(record(nodes[0]!, now + 3, "https://valid.example:9137"));
  tampered.endpoints = ["https://tampered.example:9137"];
  assert.throws(() => directory.admit(tampered, now + 4), /Invalid peer record signature/);
});

test("peer directory expires records before capacity admission", () => {
  const now = 1_800_000_200_000;
  const directory = new PeerDirectory(expected, { maxRecords: 1 });
  const first = identity();
  const second = identity();
  directory.admit(record(first, now, "https://old.example:9137"), now + 1);

  assert.equal(directory.admit(record(second, now + 60_001, "https://new.example:9137"), now + 60_002), true);
  assert.equal(directory.size, 1);
  assert.equal(directory.list(1, now + 60_002)[0]?.nodeId, second.nodeId);
});

test("peer directory uses the signed-record exact expiry boundary", () => {
  const now = 1_800_000_300_000;
  const directory = new PeerDirectory(expected, { maxRecords: 1 });
  const first = identity();
  const second = identity();
  const firstRecord = record(first, now, "https://old.example:9137");

  directory.admit(firstRecord, now + 1);
  assert.equal(directory.list(1, firstRecord.expiresAtMs - 1)[0]?.nodeId, first.nodeId);
  assert.equal(directory.list(1, firstRecord.expiresAtMs).length, 0);
  assert.equal(directory.size, 0);

  const secondRecord = record(second, firstRecord.expiresAtMs, "https://new.example:9137");
  assert.equal(directory.admit(secondRecord, firstRecord.expiresAtMs + 1), true);
  assert.equal(directory.list(1, firstRecord.expiresAtMs + 1)[0]?.nodeId, second.nodeId);
});
