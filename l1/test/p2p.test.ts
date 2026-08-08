import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import {
  authenticateP2PPeer,
  createP2PNode,
  registerP2PIdentityProtocol,
  validateP2PChainIdentity
} from "../src/p2p.js";

const chain = { chainId: "zyron-test", genesisHash: "ab".repeat(32) };

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

test("native P2P authenticates Noise peer identity and exact chain genesis", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-p2p-auth-first-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-p2p-auth-second-"));
  const firstIdentity = await loadOrCreateNodeIdentity(firstDir);
  const secondIdentity = await loadOrCreateNodeIdentity(secondDir);
  const first = await createP2PNode(firstIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  const second = await createP2PNode(secondIdentity);
  const authenticated: string[] = [];
  try {
    await registerP2PIdentityProtocol(first, firstIdentity, chain, (remote) => authenticated.push(remote.nodeId));
    await registerP2PIdentityProtocol(second, secondIdentity, chain);
    const address = first.getMultiaddrs()[0];
    assert.ok(address);
    const remote = await authenticateP2PPeer(second, address, secondIdentity, chain);
    assert.equal(remote.nodeId, firstIdentity.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(authenticated, [secondIdentity.nodeId]);
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});

test("native P2P fails closed across different chain genesis", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-p2p-chain-first-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-p2p-chain-second-"));
  const firstIdentity = await loadOrCreateNodeIdentity(firstDir);
  const secondIdentity = await loadOrCreateNodeIdentity(secondDir);
  const first = await createP2PNode(firstIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  const second = await createP2PNode(secondIdentity);
  try {
    await registerP2PIdentityProtocol(first, firstIdentity, chain);
    const address = first.getMultiaddrs()[0];
    assert.ok(address);
    await assert.rejects(
      () => authenticateP2PPeer(second, address, secondIdentity, { ...chain, genesisHash: "cd".repeat(32) }),
      /chain identity mismatch|stream|abort/i
    );
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});

test("native P2P rejects a claimed node key that is not the authenticated Noise PeerId", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-p2p-bind-first-"));
  const attackerDir = await mkdtemp(join(tmpdir(), "zyron-p2p-bind-attacker-"));
  try {
    const firstIdentity = await loadOrCreateNodeIdentity(firstDir);
    const attacker = await loadOrCreateNodeIdentity(attackerDir);
    const first = await createP2PNode(firstIdentity);
    try {
      const spoof = {
        version: 1,
        nodeId: attacker.nodeId,
        publicKey: attacker.publicKey,
        ...chain
      };
      assert.throws(
        () => validateP2PChainIdentity(spoof, chain, first.peerId),
        /Noise identity mismatch/
      );
      assert.throws(
        () => validateP2PChainIdentity({ ...spoof, extra: true }, chain, first.peerId),
        /message fields/
      );
    } finally {
      await first.stop();
    }
  } finally {
    await rm(firstDir, { recursive: true, force: true });
    await rm(attackerDir, { recursive: true, force: true });
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

test("native P2P enforces the configured connection cap under inbound churn", async () => {
  const serverDir = await mkdtemp(join(tmpdir(), "zyron-p2p-cap-server-"));
  const clientDirs = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    mkdtemp(join(tmpdir(), `zyron-p2p-cap-client-${index}-`))
  ));
  const serverIdentity = await loadOrCreateNodeIdentity(serverDir);
  const server = await createP2PNode(serverIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"], maxConnections: 2 });
  const clients = await Promise.all(clientDirs.map(async (directory) =>
    createP2PNode(await loadOrCreateNodeIdentity(directory))
  ));
  try {
    const address = server.getMultiaddrs()[0];
    assert.ok(address);
    await Promise.allSettled(clients.map((client) => client.dial(address, { signal: AbortSignal.timeout(2_000) })));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(server.getConnections().length >= 1);
    assert.ok(server.getConnections().length <= 2, `connection cap exceeded: ${server.getConnections().length}`);
  } finally {
    await Promise.allSettled([server.stop(), ...clients.map((client) => client.stop())]);
    await Promise.all([serverDir, ...clientDirs].map((directory) => rm(directory, { recursive: true, force: true })));
  }
});
