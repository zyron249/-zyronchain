import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeService } from "../src/node.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createP2PNode } from "../src/p2p.js";
import { P2P_SYNC_PROTOCOL, registerP2PSyncProtocol, syncP2PFrom } from "../src/p2p-sync.js";
import { ChainStore } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivate = "01".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validator = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("02".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("03".padStart(64, "0")));

function genesis(chainId = "zyron-native-sync-1"): GenesisConfig {
  return {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validator, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
  };
}

test("native authenticated P2P sync transfers and validates finalized blocks", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "zyron-native-sync-source-"));
  const followerDir = await mkdtemp(join(tmpdir(), "zyron-native-sync-follower-"));
  let sourceNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  let followerNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const config = genesis();
    const sourceStore = await ChainStore.open(config, sourceDir);
    const sourceService = new NodeService(sourceStore);
    const proposal = sourceStore.chain.produceBlock([], validatorPrivate, { timestampMs: config.timestampMs + 30_000 });
    await sourceService.acceptFinalizedBlock(sourceStore.chain.attestBlock(proposal, validatorPrivate));
    assert.equal(sourceService.status().height, 1);

    const followerService = new NodeService(await ChainStore.open(config, followerDir));
    const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
    const followerIdentity = await loadOrCreateNodeIdentity(followerDir);
    sourceNode = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    followerNode = await createP2PNode(followerIdentity);
    await registerP2PSyncProtocol(sourceNode, sourceIdentity, sourceService);

    const address = sourceNode.getMultiaddrs()[0];
    assert.ok(address);
    assert.equal(await syncP2PFrom(followerNode, address, followerIdentity, followerService), 1);
    assert.deepEqual(followerService.status(), sourceService.status());
    assert.equal(await syncP2PFrom(followerNode, address, followerIdentity, followerService), 0);
  } finally {
    await Promise.allSettled([sourceNode?.stop(), followerNode?.stop()]);
    await rm(sourceDir, { recursive: true, force: true });
    await rm(followerDir, { recursive: true, force: true });
  }
});

test("native P2P sync fails closed before serving a wrong-chain requester", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "zyron-native-sync-chain-source-"));
  const followerDir = await mkdtemp(join(tmpdir(), "zyron-native-sync-chain-follower-"));
  let sourceNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  let followerNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const sourceService = new NodeService(await ChainStore.open(genesis("zyron-a"), sourceDir));
    const followerService = new NodeService(await ChainStore.open(genesis("zyron-b"), followerDir));
    const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
    const followerIdentity = await loadOrCreateNodeIdentity(followerDir);
    sourceNode = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    followerNode = await createP2PNode(followerIdentity);
    await registerP2PSyncProtocol(sourceNode, sourceIdentity, sourceService);
    const address = sourceNode.getMultiaddrs()[0];
    assert.ok(address);
    await assert.rejects(() => syncP2PFrom(followerNode!, address, followerIdentity, followerService), /sync|stream|abort/i);
    assert.equal(followerService.status().height, 0);
  } finally {
    await Promise.allSettled([sourceNode?.stop(), followerNode?.stop()]);
    await rm(sourceDir, { recursive: true, force: true });
    await rm(followerDir, { recursive: true, force: true });
  }
});

test("native P2P sync detects a peer that lies about its finalized tip", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "zyron-native-sync-tip-source-"));
  const followerDir = await mkdtemp(join(tmpdir(), "zyron-native-sync-tip-follower-"));
  let sourceNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  let followerNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const config = genesis();
    const sourceStore = await ChainStore.open(config, sourceDir);
    const sourceService = new NodeService(sourceStore);
    const proposal = sourceStore.chain.produceBlock([], validatorPrivate, { timestampMs: config.timestampMs + 30_000 });
    const block = sourceStore.chain.attestBlock(proposal, validatorPrivate);
    await sourceService.acceptFinalizedBlock(block);
    const followerService = new NodeService(await ChainStore.open(config, followerDir));
    const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
    const followerIdentity = await loadOrCreateNodeIdentity(followerDir);
    sourceNode = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    followerNode = await createP2PNode(followerIdentity);
    await sourceNode.handle(P2P_SYNC_PROTOCOL, async (stream) => {
      await readTestFrame(stream);
      const response = {
        version: 1,
        identity: {
          version: 1,
          nodeId: sourceIdentity.nodeId,
          publicKey: sourceIdentity.publicKey,
          chainId: sourceService.status().chainId,
          genesisHash: sourceService.status().genesisHash
        },
        status: { ...sourceService.status(), tipHash: "00".repeat(32) },
        blocks: [block]
      };
      const body = Buffer.from(JSON.stringify(response));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      stream.send(header);
      stream.send(body);
      await stream.close();
    });
    const address = sourceNode.getMultiaddrs()[0];
    assert.ok(address);
    await assert.rejects(() => syncP2PFrom(followerNode!, address, followerIdentity, followerService), /false tip/);
    // Consensus-valid history remains committed; only the lying peer session is rejected.
    assert.equal(followerService.status().tipHash, block.hash);
  } finally {
    await Promise.allSettled([sourceNode?.stop(), followerNode?.stop()]);
    await rm(sourceDir, { recursive: true, force: true });
    await rm(followerDir, { recursive: true, force: true });
  }
});

async function readTestFrame(stream: AsyncIterable<Uint8Array | { subarray(): Uint8Array }>): Promise<void> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffered = Buffer.concat([buffered, Buffer.from(chunk.subarray())]);
    if (buffered.length < 4) continue;
    const length = buffered.readUInt32BE(0);
    if (buffered.length >= length + 4) return;
  }
  throw new Error("truncated test request");
}
