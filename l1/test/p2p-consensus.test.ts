import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectedValidator } from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { BLOCK_INTERVAL_MS, NodeService, produceFinalizedBlock } from "../src/node.js";
import { NativeConsensusPeerClient, registerP2PConsensusProtocol } from "../src/p2p-consensus.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createP2PNode } from "../src/p2p.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { createTransfer } from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

const firstPrivate = "01".padStart(64, "0");
const secondPrivate = "02".padStart(64, "0");
const firstPublic = publicKeyFromPrivate(firstPrivate);
const secondPublic = publicKeyFromPrivate(secondPrivate);
const oraclePublic = publicKeyFromPrivate("03".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("04".padStart(64, "0")));
const alicePrivate = "05".padStart(64, "0");
const alicePublic = publicKeyFromPrivate(alicePrivate);
const alice = addressFromPublicKey(alicePublic);

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-native-consensus-1",
    timestampMs: 1_700_000_000_000,
    validators: [
      { address: addressFromPublicKey(firstPublic), publicKey: firstPublic },
      { address: addressFromPublicKey(secondPublic), publicKey: secondPublic }
    ],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [
      { address: activityPool, amountAtoms: 1_000_000 },
      { address: alice, amountAtoms: 10_000 }
    ]
  };
}

test("two validators finalize and converge using native authenticated consensus streams", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "zyron-native-consensus-source-"));
  const remoteDir = await mkdtemp(join(tmpdir(), "zyron-native-consensus-remote-"));
  let sourceNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  let remoteNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const config = genesis();
    const scheduled = expectedValidator(config.validators, 1, 0).publicKey;
    const sourceKey = scheduled === firstPublic ? firstPrivate : secondPrivate;
    const remoteKey = scheduled === firstPublic ? secondPrivate : firstPrivate;
    const source = new NodeService(
      await ChainStore.open(config, sourceDir),
      await SigningJournal.open(sourceDir),
      sourceKey
    );
    const remote = new NodeService(
      await ChainStore.open(config, remoteDir),
      await SigningJournal.open(remoteDir),
      remoteKey
    );
    const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
    const remoteIdentity = await loadOrCreateNodeIdentity(remoteDir);
    sourceNode = await createP2PNode(sourceIdentity);
    remoteNode = await createP2PNode(remoteIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    await registerP2PConsensusProtocol(remoteNode, remoteIdentity, remote);
    const remoteAddress = remoteNode.getMultiaddrs()[0];
    assert.ok(remoteAddress);
    const peers = new NativeConsensusPeerClient(sourceNode, [remoteAddress], sourceIdentity, source.status());

    const block = await produceFinalizedBlock(source, peers, sourceKey, config.timestampMs + BLOCK_INTERVAL_MS);
    assert.ok(block);
    assert.equal(block.attestations.length, 2);
    assert.deepEqual(source.status(), remote.status());
    assert.equal(source.status().height, 1);

    peers.replaceTargets([]);
    assert.deepEqual(await peers.requestRoundSkips(2, 0), []);
    peers.replaceTargets([remoteAddress]);
    const skipVotes = await peers.requestRoundSkips(2, 0);
    assert.equal(skipVotes.length, 1);
    assert.equal(skipVotes[0]?.publicKey, publicKeyFromPrivate(remoteKey));

    const transaction = createTransfer({
      chainId: config.chainId,
      nonce: 1,
      sender: alice,
      receiver: activityPool,
      amountAtoms: 10,
      feeAtoms: 1,
      timestampMs: config.timestampMs + BLOCK_INTERVAL_MS + 1
    }, alicePrivate, alicePublic);
    await peers.broadcastTransaction(transaction);
    assert.equal(remote.mempool.size, 1);
    // A repeated gossip call is suppressed locally instead of consuming another
    // remote mempool admission slot.
    await peers.broadcastTransaction(transaction);
    assert.equal(remote.mempool.size, 1);
  } finally {
    await Promise.allSettled([sourceNode?.stop(), remoteNode?.stop()]);
    await rm(sourceDir, { recursive: true, force: true });
    await rm(remoteDir, { recursive: true, force: true });
  }
});
