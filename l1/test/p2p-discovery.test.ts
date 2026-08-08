import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { multiaddr } from "@multiformats/multiaddr";

import { parseNativePeerAddress } from "../src/p2p-address.js";
import { discoverNativePeersFrom, registerP2PDiscoveryProtocol } from "../src/p2p-discovery.js";
import { createP2PNode } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";

const chain = { chainId: "zyron-discovery-test", genesisHash: "9a".repeat(32) };

test("native peer exchange returns only bounded pinned hints over Noise", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-discovery-first-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-discovery-second-"));
  const advertisedDir = await mkdtemp(join(tmpdir(), "zyron-discovery-advertised-"));
  const firstIdentity = await loadOrCreateNodeIdentity(firstDir);
  const secondIdentity = await loadOrCreateNodeIdentity(secondDir);
  const advertisedIdentity = await loadOrCreateNodeIdentity(advertisedDir);
  const first = await createP2PNode(firstIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  const second = await createP2PNode(secondIdentity);
  const advertised = await createP2PNode(advertisedIdentity);
  try {
    const hint = parseNativePeerAddress(`/dns4/peer.example/tcp/9140/p2p/${advertised.peerId.toString()}`);
    await registerP2PDiscoveryProtocol(first, firstIdentity, chain, () => [hint]);
    const address = first.getMultiaddrs()[0];
    assert.ok(address);
    const found = await discoverNativePeersFrom(second, address, secondIdentity, chain);
    assert.deepEqual(found.map((peer) => peer.toString()), [hint.toString()]);
  } finally {
    await Promise.allSettled([first.stop(), second.stop(), advertised.stop()]);
    await Promise.all([firstDir, secondDir, advertisedDir].map((directory) => rm(directory, { recursive: true, force: true })));
  }
});

test("native peer exchange fails closed across chain identity", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-discovery-chain-first-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-discovery-chain-second-"));
  const firstIdentity = await loadOrCreateNodeIdentity(firstDir);
  const secondIdentity = await loadOrCreateNodeIdentity(secondDir);
  const first = await createP2PNode(firstIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  const second = await createP2PNode(secondIdentity);
  try {
    await registerP2PDiscoveryProtocol(first, firstIdentity, chain, () => []);
    const address = first.getMultiaddrs()[0];
    assert.ok(address);
    await assert.rejects(
      () => discoverNativePeersFrom(second, address, secondIdentity, { ...chain, genesisHash: "55".repeat(32) }),
      /chain identity mismatch|stream|abort/i
    );
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
    await Promise.all([firstDir, secondDir].map((directory) => rm(directory, { recursive: true, force: true })));
  }
});

test("native peer exchange never emits unpinned or duplicate PeerIds", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-discovery-invalid-first-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-discovery-invalid-second-"));
  const firstIdentity = await loadOrCreateNodeIdentity(firstDir);
  const secondIdentity = await loadOrCreateNodeIdentity(secondDir);
  const first = await createP2PNode(firstIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  const second = await createP2PNode(secondIdentity);
  try {
    await registerP2PDiscoveryProtocol(first, firstIdentity, chain, () => [multiaddr("/ip4/127.0.0.1/tcp/9140")]);
    const address = first.getMultiaddrs()[0];
    assert.ok(address);
    await assert.rejects(() => discoverNativePeersFrom(second, address, secondIdentity, chain), /stream|discovery|abort/i);

    const pinned = parseNativePeerAddress(`${address.toString()}`);
    const otherDir = await mkdtemp(join(tmpdir(), "zyron-discovery-duplicate-"));
    try {
      const otherIdentity = await loadOrCreateNodeIdentity(otherDir);
      const other = await createP2PNode(otherIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
      try {
        const otherAddress = other.getMultiaddrs()[0];
        assert.ok(otherAddress);
        const duplicatePeerId = parseNativePeerAddress(`/dns4/alternate.example/tcp/9140/p2p/${other.peerId.toString()}`);
        // Same PeerId at two addresses is rejected rather than amplifying one identity.
        await registerP2PDiscoveryProtocol(other, otherIdentity, chain, () => [otherAddress, duplicatePeerId]);
        await assert.rejects(() => discoverNativePeersFrom(second, otherAddress, secondIdentity, chain), /stream|duplicate|abort/i);
      } finally { await other.stop(); }
    } finally { await rm(otherDir, { recursive: true, force: true }); }
    assert.ok(pinned);
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
    await Promise.all([firstDir, secondDir].map((directory) => rm(directory, { recursive: true, force: true })));
  }
});
