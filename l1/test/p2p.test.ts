import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createP2PNode } from "../src/p2p.js";

test("native P2P reuses the persistent node identity over authenticated Noise", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-p2p-first-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-p2p-second-"));
  const firstIdentity = await loadOrCreateNodeIdentity(firstDir);
  const secondIdentity = await loadOrCreateNodeIdentity(secondDir);
  let first = await createP2PNode(firstIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  const second = await createP2PNode(secondIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  try {
    const firstPeerId = first.peerId.toString();
    const address = first.getMultiaddrs()[0];
    assert.ok(address);
    const connection = await second.dial(address);
    assert.equal(connection.remotePeer.toString(), firstPeerId);
    assert.equal(connection.encryption, "/noise");

    await first.stop();
    first = await createP2PNode(firstIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    assert.equal(first.peerId.toString(), firstPeerId);
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});

test("native P2P fails closed when node identity fields do not bind the transport key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-p2p-identity-bind-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    const tampered = { ...identity, nodeId: "00".repeat(32) };
    await assert.rejects(() => createP2PNode(tampered), /does not bind P2P transport key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
