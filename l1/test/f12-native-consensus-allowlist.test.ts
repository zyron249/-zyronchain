// F-12: the native libp2p consensus protocols authenticated the transport
// (Noise) but accepted consensus messages from any peer that presented the
// public chainId/genesisHash. With an operator-configured consensus peer
// allowlist, consensus messages from other peers are refused before any
// service work; transaction gossip stays open.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectedValidator } from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { BLOCK_INTERVAL_MS, NodeService, produceFinalizedBlock } from "../src/node.js";
import {
  NativeConsensusPeerClient,
  parseNativeConsensusPeerAllowlist,
  registerP2PConsensusProtocol
} from "../src/p2p-consensus.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createP2PNode } from "../src/p2p.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { createTransfer } from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

const firstPrivate = "01".padStart(64, "0");
const secondPrivate = "02".padStart(64, "0");
const firstPublic = publicKeyFromPrivate(firstPrivate);
const secondPublic = publicKeyFromPrivate(secondPrivate);
const alicePrivate = "05".padStart(64, "0");
const alicePublic = publicKeyFromPrivate(alicePrivate);
const alice = addressFromPublicKey(alicePublic);
const bob = addressFromPublicKey(publicKeyFromPrivate("06".padStart(64, "0")));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("04".padStart(64, "0")));

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-f12-allowlist",
    timestampMs: 1_700_000_000_000,
    validators: [
      { address: addressFromPublicKey(firstPublic), publicKey: firstPublic },
      { address: addressFromPublicKey(secondPublic), publicKey: secondPublic }
    ],
    activityOracles: [publicKeyFromPrivate("03".padStart(64, "0"))],
    activityPool,
    allocations: [
      { address: activityPool, amountAtoms: 1_000_000 },
      { address: alice, amountAtoms: 10_000 }
    ]
  };
}

test("F-12: allowlist parsing accepts peer ids only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-f12-parse-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    const node = await createP2PNode(identity);
    try {
      const id = node.peerId.toString();
      assert.deepEqual([...parseNativeConsensusPeerAllowlist([id, id])], [id]);
      assert.equal(parseNativeConsensusPeerAllowlist([]), undefined);
      assert.throws(() => parseNativeConsensusPeerAllowlist(["not-a-peer-id"]), /Invalid --p2p-consensus-peer/);
    } finally {
      await node.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("F-12: consensus messages from a peer outside the allowlist are refused before any service work", { timeout: 60_000 }, async () => {
  const dirs = await Promise.all(["source", "remote", "stranger"].map((name) => mkdtemp(join(tmpdir(), `zyron-f12-${name}-`))));
  const nodes: Array<Awaited<ReturnType<typeof createP2PNode>>> = [];
  try {
    const config = genesis();
    const scheduled = expectedValidator(config.validators, 1, 0).publicKey;
    const sourceKey = scheduled === firstPublic ? firstPrivate : secondPrivate;
    const remoteKey = scheduled === firstPublic ? secondPrivate : firstPrivate;
    const source = new NodeService(await ChainStore.open(config, dirs[0]!), await SigningJournal.open(dirs[0]!), sourceKey);
    const remote = new NodeService(await ChainStore.open(config, dirs[1]!), await SigningJournal.open(dirs[1]!), remoteKey);
    // A stranger running the same chain (public chainId/genesisHash) holding
    // the scheduled proposer's key material is still not an allowlisted peer.
    const stranger = new NodeService(await ChainStore.open(config, dirs[2]!), await SigningJournal.open(dirs[2]!), sourceKey);
    const [sourceIdentity, remoteIdentity, strangerIdentity] = await Promise.all(dirs.map((dir) => loadOrCreateNodeIdentity(dir)));
    const sourceNode = await createP2PNode(sourceIdentity!);
    const strangerNode = await createP2PNode(strangerIdentity!);
    const remoteNode = await createP2PNode(remoteIdentity!, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    nodes.push(sourceNode, strangerNode, remoteNode);

    let serviceCalls = 0;
    for (const name of ["attestProposal", "requestSkipVote", "acceptFinalizedBlock", "v6Prepare", "v6Commit", "v6Timeout", "v6FetchBlock"] as const) {
      const original = (remote[name] as (...args: unknown[]) => unknown).bind(remote);
      (remote as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        serviceCalls += 1;
        return original(...args);
      };
    }
    await registerP2PConsensusProtocol(remoteNode, remoteIdentity!, remote, {
      consensusPeerAllowlist: parseNativeConsensusPeerAllowlist([sourceNode.peerId.toString()])
    });
    const remoteAddress = remoteNode.getMultiaddrs()[0];
    assert.ok(remoteAddress);

    const strangerPeers = new NativeConsensusPeerClient(strangerNode, [remoteAddress], strangerIdentity!, stranger.status());
    assert.equal(await produceFinalizedBlock(stranger, strangerPeers, sourceKey, config.timestampMs + BLOCK_INTERVAL_MS), null);
    assert.deepEqual(await strangerPeers.requestRoundSkips(1, 0), []);
    assert.deepEqual(await strangerPeers.requestV6Timeouts(1, 0), []);
    assert.equal(await strangerPeers.fetchV6Block(1, "00".repeat(32)), null);
    assert.equal(serviceCalls, 0, "a non-allowlisted peer reached a consensus service method");
    assert.equal(remote.status().height, 0);

    // Transaction gossip is not a consensus message and stays open.
    const transaction = createTransfer({
      chainId: config.chainId,
      nonce: 1,
      sender: alice,
      receiver: bob,
      amountAtoms: 10,
      feeAtoms: 1,
      timestampMs: config.timestampMs + BLOCK_INTERVAL_MS + 1
    }, alicePrivate, alicePublic);
    await strangerPeers.broadcastTransaction(transaction);
    assert.equal(remote.mempool.size, 1);

    // The allowlisted peer finalizes with the remote validator as before.
    const sourcePeers = new NativeConsensusPeerClient(sourceNode, [remoteAddress], sourceIdentity!, source.status());
    const block = await produceFinalizedBlock(source, sourcePeers, sourceKey, config.timestampMs + BLOCK_INTERVAL_MS);
    assert.ok(block);
    assert.equal(block.attestations.length, 2);
    assert.equal(remote.status().height, 1);
    assert.ok(serviceCalls > 0);
  } finally {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});
