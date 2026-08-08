import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import type { Stream } from "@libp2p/interface";
import type { Libp2p } from "libp2p";

import { publicKeyFromPrivate } from "../src/crypto.js";
import { parseNativePeerAddress } from "../src/p2p-address.js";
import { assertSafeDiscoveredPeer, MAX_DYNAMIC_NATIVE_PEERS, NativePeerPool } from "../src/p2p-peer-pool.js";
import { nodeIdFromPublicKey, type NodeIdentity } from "../src/peer-identity.js";

function peerId(index: number): string {
  return peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from(index.toString(16).padStart(64, "0"), "hex"))).toString();
}

test("discovery dial policy blocks internal, reserved and DNS-rebinding candidates", () => {
  const id = peerId(1);
  for (const host of ["10.1.2.3", "127.0.0.1", "169.254.1.1", "192.168.4.5", "100.64.1.2", "198.51.100.8"]) {
    assert.throws(
      () => assertSafeDiscoveredPeer(parseNativePeerAddress(`/ip4/${host}/tcp/9140/p2p/${id}`)),
      /non-public/
    );
  }
  assert.throws(
    () => assertSafeDiscoveredPeer(parseNativePeerAddress(`/dns4/rebind.example/tcp/9140/p2p/${id}`)),
    /public IP/
  );
  assert.equal(
    assertSafeDiscoveredPeer(parseNativePeerAddress(`/ip4/8.8.8.8/tcp/9140/p2p/${id}`)).toString(),
    `/ip4/8.8.8.8/tcp/9140/p2p/${id}`
  );
});

test("native peer pool rejects duplicate/self seeds and preserves diversity ordering", () => {
  const local = peerId(1);
  const first = parseNativePeerAddress(`/ip4/8.8.8.8/tcp/9140/p2p/${peerId(2)}`);
  const second = parseNativePeerAddress(`/ip4/1.1.1.1/tcp/9140/p2p/${peerId(3)}`);
  const pool = new NativePeerPool([first, second], local);
  assert.equal(pool.size, 2);
  assert.deepEqual(pool.snapshot().map((peer) => peer.toString()), [first.toString(), second.toString()]);
  assert.throws(() => new NativePeerPool([first, first], local), /Duplicate/);
  assert.throws(
    () => new NativePeerPool([parseNativePeerAddress(`/ip4/8.8.4.4/tcp/9140/p2p/${local}`)], local),
    /local PeerId/
  );
});

test("verified dynamic admission caps one source and one topology failure domain", async () => {
  const chain = { chainId: "zyron-pool-test", genesisHash: "a4".repeat(32) };
  const local = identity(200);
  const source = peerId(201);
  const remotes = new Map<string, NodeIdentity>();
  const candidates = Array.from({ length: 9 }, (_, offset) => {
    const remote = identity(offset + 20);
    const id = peerIdFromIdentity(remote);
    remotes.set(id, remote);
    // Every candidate is in a different public /24 so the source cap is the
    // limiting factor rather than the topology cap.
    return parseNativePeerAddress(`/ip4/${30 + offset}.8.8.8/tcp/9140/p2p/${id}`);
  });
  const node = fakeIdentityNode(remotes, chain);
  const pool = new NativePeerPool([], peerIdFromIdentity(local));
  for (const candidate of candidates.slice(0, 8)) {
    assert.equal(await pool.verifyAndAdmit(node, local, chain, candidate, source), true);
  }
  assert.equal(await pool.verifyAndAdmit(node, local, chain, candidates[8]!, source), false);
  const evictedPeerId = candidates[0]!.getComponents()[2]!.value!;
  assert.equal(pool.isDynamic(evictedPeerId), true);
  assert.equal(pool.evictDynamic(evictedPeerId), true);
  assert.equal(pool.isDynamic(evictedPeerId), false);
  // Churn must release both total capacity and the per-source slot.
  assert.equal(await pool.verifyAndAdmit(node, local, chain, candidates[8]!, source), true);

  const topologyPool = new NativePeerPool([], peerIdFromIdentity(local));
  const topologyCandidates = Array.from({ length: 3 }, (_, offset) => {
    const remote = identity(offset + 60);
    const id = peerIdFromIdentity(remote);
    remotes.set(id, remote);
    return parseNativePeerAddress(`/ip4/44.55.66.${10 + offset}/tcp/9140/p2p/${id}`);
  });
  assert.equal(await topologyPool.verifyAndAdmit(node, local, chain, topologyCandidates[0]!, source), true);
  assert.equal(await topologyPool.verifyAndAdmit(node, local, chain, topologyCandidates[1]!, source), true);
  assert.equal(await topologyPool.verifyAndAdmit(node, local, chain, topologyCandidates[2]!, source), false);
});

test("concurrent Sybil admission cannot race past one topology cap and seeds cannot be evicted", async () => {
  const chain = { chainId: "zyron-pool-race", genesisHash: "b5".repeat(32) };
  const local = identity(220);
  const source = peerId(221);
  const remotes = new Map<string, NodeIdentity>();
  const candidates = Array.from({ length: 8 }, (_, offset) => {
    const remote = identity(offset + 100);
    const id = peerIdFromIdentity(remote);
    remotes.set(id, remote);
    return parseNativePeerAddress(`/ip4/46.70.80.${20 + offset}/tcp/9140/p2p/${id}`);
  });
  const seed = parseNativePeerAddress(`/ip4/8.8.4.4/tcp/9140/p2p/${peerId(222)}`);
  const pool = new NativePeerPool([seed], peerIdFromIdentity(local));
  const accepted = await Promise.all(candidates.map((candidate) =>
    pool.verifyAndAdmit(fakeIdentityNode(remotes, chain), local, chain, candidate, source)
  ));
  assert.equal(accepted.filter(Boolean).length, 2);
  assert.equal(pool.size, 3);
  assert.equal(pool.evictDynamic(peerId(222)), false);
  assert.equal(pool.size, 3);
});

test("dynamic admission fails closed when Noise identity does not match the pinned candidate", async () => {
  const chain = { chainId: "zyron-pool-test", genesisHash: "a4".repeat(32) };
  const local = identity(210);
  const advertised = identity(211);
  const imposter = identity(212);
  const advertisedPeerId = peerIdFromIdentity(advertised);
  const candidate = parseNativePeerAddress(`/ip4/45.67.89.10/tcp/9140/p2p/${advertisedPeerId}`);
  // The fake transport reports the pinned PeerId but returns a different
  // application key. validateP2PChainIdentity must reject the mismatch.
  const node = fakeIdentityNode(new Map([[advertisedPeerId, imposter]]), chain, advertisedPeerId);
  const pool = new NativePeerPool([], peerIdFromIdentity(local));
  await assert.rejects(() => pool.verifyAndAdmit(node, local, chain, candidate, peerId(213)), /Noise identity mismatch/);
  assert.equal(pool.size, 0);
});

test("eclipse-majority churn cannot exceed the dynamic reserve or displace a bootstrap seed", async () => {
  const chain = { chainId: "zyron-pool-eclipse", genesisHash: "c6".repeat(32) };
  const local = identity(500);
  const seed = parseNativePeerAddress(`/ip4/8.8.8.8/tcp/9140/p2p/${peerId(501)}`);
  const pool = new NativePeerPool([seed], peerIdFromIdentity(local));
  const admittedPeerIds: string[] = [];

  for (let batch = 0; batch < 4; batch += 1) {
    const source = peerId(510 + batch);
    const remotes = new Map<string, NodeIdentity>();
    const candidates = Array.from({ length: 8 }, (_, offset) => {
      const remote = identity(520 + (batch * 8) + offset);
      const id = peerIdFromIdentity(remote);
      remotes.set(id, remote);
      admittedPeerIds.push(id);
      return parseNativePeerAddress(`/ip4/${50 + (batch * 8) + offset}.90.1.1/tcp/9140/p2p/${id}`);
    });
    const accepted = await Promise.all(candidates.map((candidate) =>
      pool.verifyAndAdmit(fakeIdentityNode(remotes, chain), local, chain, candidate, source)
    ));
    assert.equal(accepted.filter(Boolean).length, 8);
  }
  assert.equal(pool.size, 1 + MAX_DYNAMIC_NATIVE_PEERS);
  assert.equal(pool.isDynamic(peerId(501)), false);

  // A fifth attacker source cannot exceed the global dynamic reserve.
  const overflow = identity(600);
  const overflowId = peerIdFromIdentity(overflow);
  const overflowAddress = parseNativePeerAddress(`/ip4/90.90.1.1/tcp/9140/p2p/${overflowId}`);
  assert.equal(
    await pool.verifyAndAdmit(fakeIdentityNode(new Map([[overflowId, overflow]]), chain), local, chain, overflowAddress, peerId(601)),
    false
  );

  // Simulated churn frees capacity without touching the operator bootstrap.
  for (const id of admittedPeerIds.filter((_, index) => index % 2 === 0)) assert.equal(pool.evictDynamic(id), true);
  assert.equal(pool.size, 1 + (MAX_DYNAMIC_NATIVE_PEERS / 2));
  assert.equal(pool.has(peerId(501)), true);
});

function identity(index: number): NodeIdentity {
  const privateKey = index.toString(16).padStart(64, "0");
  const publicKey = publicKeyFromPrivate(privateKey);
  return { version: 1, privateKey, publicKey, nodeId: nodeIdFromPublicKey(publicKey) };
}

function peerIdFromIdentity(value: NodeIdentity): string {
  return peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from(value.privateKey, "hex"))).toString();
}

function fakeIdentityNode(
  remotes: ReadonlyMap<string, NodeIdentity>,
  chain: { chainId: string; genesisHash: string },
  forcedTransportPeerId?: string
): Libp2p {
  return {
    async dial(target: unknown) {
      const pinned = (target as { toString(): string }).toString().split("/p2p/")[1]!;
      const remote = remotes.get(pinned);
      if (!remote) throw new Error("test remote not found");
      const transportPeerId = forcedTransportPeerId ?? pinned;
      const remotePeer = peerIdFromString(transportPeerId);
      return {
        encryption: "/noise",
        remotePeer,
        abort() {},
        async newStream() {
          const response = Buffer.from(`${JSON.stringify({
            version: 1,
            nodeId: remote.nodeId,
            publicKey: remote.publicKey,
            ...chain
          })}\n`);
          return {
            inactivityTimeout: 0,
            send() { return true; },
            async close() {},
            abort() {},
            async *[Symbol.asyncIterator]() { yield response; }
          } as unknown as Stream;
        }
      };
    }
  } as unknown as Libp2p;
}
