import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeService } from "../src/node.js";
import {
  fetchTrustedSnapshotFromPeer,
  P2P_CHECKPOINT_PROTOCOL,
  registerP2PCheckpointProtocol
} from "../src/p2p-checkpoint.js";
import { readP2PFrame, writeP2PFrame } from "../src/p2p-frame.js";
import { createP2PNode } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { ChainStore } from "../src/storage.js";
import {
  createProtocolUpgrade,
  createProtocolUpgradeApproval
} from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivate = "11".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validator = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("12".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("13".padStart(64, "0")));
const execFileAsync = promisify(execFile);

function genesis(chainId = "zyron-checkpoint-p2p-1"): GenesisConfig {
  return {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validator, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
  };
}

async function advanceToStateV2(store: ChainStore): Promise<void> {
  const config = genesis();
  const proposal = {
    chainId: config.chainId,
    nonce: 1,
    sender: validator,
    activationHeight: 101,
    protocolVersion: 2
  };
  const upgrade = createProtocolUpgrade({
    ...proposal,
    approvals: [createProtocolUpgradeApproval(proposal, validatorPrivate, validatorPublic)],
    timestampMs: config.timestampMs + 1
  }, validatorPrivate, validatorPublic);
  for (let height = 1; height <= 101; height += 1) {
    let block = store.chain.produceBlock(height === 1 ? [upgrade] : [], validatorPrivate, {
      timestampMs: config.timestampMs + (height * 100)
    });
    block = store.chain.attestBlock(block, validatorPrivate);
    await store.commitFinalizedBlock(block, config.timestampMs + (height * 100));
  }
}

test("native checkpoint transfer carries bytes over Noise but requires an external exact anchor", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-p2p-checkpoint-"));
  const sourceDir = join(root, "source");
  const clientIdentityDir = join(root, "client-identity");
  const installedDir = join(root, "installed");
  const cliInstalledDir = join(root, "cli-installed");
  let sourceNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  let clientNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const config = genesis();
    const sourceStore = await ChainStore.open(config, sourceDir);
    await advanceToStateV2(sourceStore);
    const snapshot = sourceStore.chain.snapshot();
    const anchor = {
      tipHash: sourceStore.chain.tip.hash,
      snapshotSha256: sha256Hex(canonicalJson(snapshot))
    };
    const originalSnapshot = sourceStore.chain.snapshot.bind(sourceStore.chain);
    let servedSnapshotMaterializations = 0;
    sourceStore.chain.snapshot = () => {
      servedSnapshotMaterializations += 1;
      return originalSnapshot();
    };
    const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
    const clientIdentity = await loadOrCreateNodeIdentity(clientIdentityDir);
    sourceNode = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    clientNode = await createP2PNode(clientIdentity);
    await registerP2PCheckpointProtocol(sourceNode, sourceIdentity, new NodeService(sourceStore));
    const address = sourceNode.getMultiaddrs()[0];
    assert.ok(address);

    // A wrong digest for the exact current tip is rejected, but the canonical
    // local candidate is cached independently of requester input. Repeating the
    // mismatch must not force another full snapshot serialization.
    for (const digest of ["00".repeat(32), "01".repeat(32)]) {
      await assert.rejects(
        () => fetchTrustedSnapshotFromPeer(clientNode!, address, clientIdentity, config, {
          tipHash: anchor.tipHash,
          snapshotSha256: digest
        }),
        /stream|checkpoint|abort|reset/i
      );
    }
    assert.equal(servedSnapshotMaterializations, 1);

    const fetched = await fetchTrustedSnapshotFromPeer(clientNode, address, clientIdentity, config, anchor);
    assert.equal(servedSnapshotMaterializations, 1);
    assert.equal(sha256Hex(canonicalJson(fetched)), anchor.snapshotSha256);
    assert.equal(fetched.tip.hash, anchor.tipHash);
    const installed = await ChainStore.installTrustedSnapshot(config, installedDir, fetched, anchor);
    assert.equal(installed.chain.tip.hash, sourceStore.chain.tip.hash);
    assert.equal(installed.firstStoredHeight, 102);

    const genesisPath = join(root, "genesis.json");
    await writeFile(genesisPath, `${canonicalJson(config)}\n`, "utf8");
    const cli = await execFileAsync(process.execPath, [
      join(process.cwd(), "dist/src/cli.js"), "checkpoint-fetch-install",
      "--genesis", genesisPath,
      "--p2p-peer", address.toString(),
      "--data", cliInstalledDir,
      "--tip-hash", anchor.tipHash,
      "--sha256", anchor.snapshotSha256
    ]);
    assert.match(cli.stdout, /Trusted checkpoint fetched and installed at height 101/);
    const cliInstalled = await ChainStore.open(config, cliInstalledDir);
    assert.equal(cliInstalled.chain.tip.hash, anchor.tipHash);
    assert.equal(cliInstalled.firstStoredHeight, 102);
  } finally {
    await Promise.allSettled([sourceNode?.stop(), clientNode?.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("native checkpoint client rejects peer bytes that do not match the external digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-p2p-checkpoint-tamper-"));
  const sourceDir = join(root, "source");
  const clientDir = join(root, "client");
  let sourceNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  let clientNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const config = genesis();
    const sourceStore = await ChainStore.open(config, sourceDir);
    let block = sourceStore.chain.produceBlock([], validatorPrivate, { timestampMs: config.timestampMs + 100 });
    block = sourceStore.chain.attestBlock(block, validatorPrivate);
    await sourceStore.commitFinalizedBlock(block, config.timestampMs + 100);
    const snapshot = sourceStore.chain.snapshot();
    const canonical = canonicalJson(snapshot);
    const anchor = { tipHash: block.hash, snapshotSha256: sha256Hex(canonical) };
    const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
    const clientIdentity = await loadOrCreateNodeIdentity(clientDir);
    sourceNode = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    clientNode = await createP2PNode(clientIdentity);
    await sourceNode.handle(P2P_CHECKPOINT_PROTOCOL, async (stream) => {
      await readP2PFrame(stream, 4_096, 5_000);
      const tampered = Buffer.from(canonical, "utf8");
      tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
      await writeP2PFrame(stream, {
        version: 1,
        identity: {
          version: 1,
          nodeId: sourceIdentity.nodeId,
          publicKey: sourceIdentity.publicKey,
          chainId: config.chainId,
          genesisHash: sourceStore.chain.genesisHash
        },
        tipHash: anchor.tipHash,
        snapshotSha256: anchor.snapshotSha256,
        height: 1,
        totalBytes: tampered.length,
        offset: 0,
        data: tampered.toString("base64")
      }, 400_000, 5_000);
      await stream.close();
    });
    const address = sourceNode.getMultiaddrs()[0];
    assert.ok(address);
    await assert.rejects(
      () => fetchTrustedSnapshotFromPeer(clientNode!, address, clientIdentity, config, anchor),
      /digest mismatch/
    );
  } finally {
    await Promise.allSettled([sourceNode?.stop(), clientNode?.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});
