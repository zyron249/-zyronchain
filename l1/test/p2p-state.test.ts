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
import { readP2PFrame, writeP2PFrame } from "../src/p2p-frame.js";
import {
  fetchTrustedPortableStateFromPeer,
  fetchTrustedPortableStateResumableFromPeer,
  P2P_STATE_PROTOCOL,
  registerP2PStateProtocol
} from "../src/p2p-state.js";
import { createP2PNode } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createStateV2PortableBundle, type StateV2PortableBundleV1 } from "../src/state-v2-portable.js";
import { ChainStore, type TrustedSnapshotAnchor } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import type { Block, GenesisConfig } from "../src/types.js";

const validatorPrivate = "21".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validator = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("22".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("23".padStart(64, "0")));
const execFileAsync = promisify(execFile);

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-portable-state-p2p-1",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validator, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
  };
}

async function advanceToStateV2(store: ChainStore): Promise<void> {
  const config = genesis();
  const proposal = { chainId: config.chainId, nonce: 1, sender: validator, activationHeight: 101, protocolVersion: 2 };
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

function portableFixture(store: ChainStore): { anchor: TrustedSnapshotAnchor; tip: Block; bundle: StateV2PortableBundleV1 } {
  const snapshot = store.chain.snapshot();
  const state = store.chain.stateV2ForPersistence();
  assert.ok(state);
  return {
    anchor: { tipHash: snapshot.tip.hash, snapshotSha256: sha256Hex(canonicalJson(snapshot)) },
    tip: snapshot.tip,
    bundle: createStateV2PortableBundle(state, snapshot.state, {
      validatorSchedule: snapshot.validatorSchedule,
      protocolSchedule: snapshot.protocolSchedule
    })
  };
}

test("portable State-v2 transfer is Noise-authenticated, externally anchored, and installable", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-p2p-state-"));
  const sourceDir = join(root, "source");
  const clientDir = join(root, "client");
  const installedDir = join(root, "installed");
  const cliInstalledDir = join(root, "cli-installed");
  let sourceNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  let clientNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const config = genesis();
    const store = await ChainStore.open(config, sourceDir);
    await advanceToStateV2(store);
    const { anchor } = portableFixture(store);
    const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
    const clientIdentity = await loadOrCreateNodeIdentity(clientDir);
    sourceNode = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    clientNode = await createP2PNode(clientIdentity);
    await registerP2PStateProtocol(sourceNode, sourceIdentity, new NodeService(store));
    const address = sourceNode.getMultiaddrs()[0];
    assert.ok(address);

    const fetched = await fetchTrustedPortableStateFromPeer(clientNode, address, clientIdentity, config, anchor);
    assert.equal(fetched.tip.hash, anchor.tipHash);
    assert.equal(fetched.bundle.root, store.chain.tip.header.stateRoot);
    const installed = await ChainStore.installTrustedPortableState(config, installedDir, fetched.tip, fetched.bundle, anchor);
    assert.equal(installed.chain.tip.hash, anchor.tipHash);
    assert.equal(installed.firstStoredHeight, 102);

    const genesisPath = join(root, "genesis.json");
    await writeFile(genesisPath, `${canonicalJson(config)}\n`, "utf8");
    const cli = await execFileAsync(process.execPath, [
      join(process.cwd(), "dist/src/cli.js"), "state-fetch-install",
      "--genesis", genesisPath,
      "--p2p-peer", address.toString(),
      "--data", cliInstalledDir,
      "--tip-hash", anchor.tipHash,
      "--sha256", anchor.snapshotSha256
    ]);
    assert.match(cli.stdout, /Trusted portable State-v2 fetched and installed at height 101/);
    const cliInstalled = await ChainStore.open(config, cliInstalledDir);
    assert.equal(cliInstalled.chain.tip.hash, anchor.tipHash);

    await assert.rejects(
      () => fetchTrustedPortableStateFromPeer(clientNode!, address, clientIdentity, config, {
        tipHash: anchor.tipHash, snapshotSha256: "00".repeat(32)
      }),
      /state|stream|abort|reset/i
    );
  } finally {
    await Promise.allSettled([sourceNode?.stop(), clientNode?.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("portable State-v2 client retries the same indexed chunk after an interrupted stream", async () => {
  const fixture = await createFixture("retry");
  let aborted = false;
  let recordRequests = 0;
  try {
    await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
      const request = await readRequest(stream);
      if (request.kind === "records") {
        recordRequests += 1;
        if (!aborted) {
          aborted = true;
          stream.abort(new Error("injected interruption"));
          return;
        }
      }
      await writeFixtureResponse(stream, fixture, request);
    });
    const fetched = await fetchTrustedPortableStateFromPeer(
      fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor
    );
    assert.equal(fetched.tip.hash, fixture.anchor.tipHash);
    assert.ok(recordRequests >= 2, "the interrupted absolute record index must be requested again");
  } finally {
    await fixture.close();
  }
});

test("portable State-v2 download resumes from fsynced chunk staging across client invocations", async () => {
  const fixture = await createFixture("durable-resume");
  const resumeDir = join(fixture.root, "resume");
  let recordRequests = 0;
  let keyFailuresRemaining = 3;
  try {
    await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
      const request = await readRequest(stream);
      if (request.kind === "records") recordRequests += 1;
      if (request.kind === "keys" && keyFailuresRemaining > 0) {
        keyFailuresRemaining -= 1;
        stream.abort(new Error("injected process-boundary interruption"));
        return;
      }
      await writeFixtureResponse(stream, fixture, request);
    });
    await assert.rejects(
      () => fetchTrustedPortableStateResumableFromPeer(
        fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir
      ),
      /stream|reset|abort|closed/i
    );
    assert.equal(recordRequests, 1, "the completed record chunk should be durable before interruption");
    await writeFile(join(resumeDir, ".tmp", "crash-orphan.tmp"), "uncommitted", "utf8");

    const fetched = await fetchTrustedPortableStateResumableFromPeer(
      fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir
    );
    assert.equal(fetched.tip.hash, fixture.anchor.tipHash);
    assert.equal(recordRequests, 1, "restart must skip the already fsynced record range");

    await writeFile(join(resumeDir, "records", "0.json"), "{}\n", "utf8");
    await assert.rejects(
      () => fetchTrustedPortableStateResumableFromPeer(
        fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir
      ),
      /resume|corrupt|checksum/i
    );
  } finally {
    await fixture.close();
  }
});

test("portable State-v2 client rejects poisoned node chunks under a correct external anchor", async () => {
  const fixture = await createFixture("poison");
  try {
    await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
      const request = await readRequest(stream);
      if (request.kind !== "records") return writeFixtureResponse(stream, fixture, request);
      const source = structuredClone(fixture.bundle.records.slice(request.start, request.start + request.limit));
      const first = source[0];
      assert.ok(first);
      first.hash = "00".repeat(32);
      await writeChunk(stream, fixture, request, source);
    });
    await assert.rejects(
      () => fetchTrustedPortableStateFromPeer(
        fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor
      ),
      /portable|root|node|hash|state/i
    );
  } finally {
    await fixture.close();
  }
});

interface RequestShape { kind: "manifest" | "records" | "keys"; start: number; limit: number }

async function readRequest(stream: Parameters<typeof readP2PFrame>[0]): Promise<RequestShape> {
  const value = await readP2PFrame(stream, 4_096, 5_000) as Record<string, unknown>;
  assert.ok(value.kind === "manifest" || value.kind === "records" || value.kind === "keys");
  assert.ok(Number.isSafeInteger(value.start));
  assert.ok(Number.isSafeInteger(value.limit));
  return { kind: value.kind, start: Number(value.start), limit: Number(value.limit) };
}

async function writeFixtureResponse(
  stream: Parameters<typeof writeP2PFrame>[0],
  fixture: Awaited<ReturnType<typeof createFixture>>,
  request: RequestShape
): Promise<void> {
  if (request.kind === "manifest") {
    await writeP2PFrame(stream, {
      version: 1, identity: peerIdentity(fixture), tipHash: fixture.anchor.tipHash,
      snapshotSha256: fixture.anchor.snapshotSha256, height: fixture.tip.header.height,
      stateRoot: fixture.bundle.root, recordCount: fixture.bundle.records.length,
      keyCount: fixture.bundle.keyPreimages.length, tip: fixture.tip
    }, 2_500_000, 5_000);
    await stream.close();
    return;
  }
  const source = request.kind === "records" ? fixture.bundle.records : fixture.bundle.keyPreimages;
  await writeChunk(stream, fixture, request, source.slice(request.start, request.start + request.limit));
}

async function writeChunk(
  stream: Parameters<typeof writeP2PFrame>[0],
  fixture: Awaited<ReturnType<typeof createFixture>>,
  request: RequestShape,
  items: unknown[]
): Promise<void> {
  await writeP2PFrame(stream, {
    version: 1, identity: peerIdentity(fixture), tipHash: fixture.anchor.tipHash,
    snapshotSha256: fixture.anchor.snapshotSha256, kind: request.kind,
    start: request.start, items
  }, 20 * 1024 * 1024, 5_000);
  await stream.close();
}

function peerIdentity(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    version: 1 as const,
    nodeId: fixture.sourceIdentity.nodeId,
    publicKey: fixture.sourceIdentity.publicKey,
    chainId: fixture.config.chainId,
    genesisHash: fixture.store.chain.genesisHash
  };
}

async function createFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `zyron-p2p-state-${name}-`));
  const config = genesis();
  const sourceDir = join(root, "source");
  const store = await ChainStore.open(config, sourceDir);
  await advanceToStateV2(store);
  const { anchor, tip, bundle } = portableFixture(store);
  const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
  const clientIdentity = await loadOrCreateNodeIdentity(join(root, "client"));
  const sourceNode = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  const clientNode = await createP2PNode(clientIdentity);
  const address = sourceNode.getMultiaddrs()[0];
  assert.ok(address);
  return {
    root, config, store, anchor, tip, bundle, sourceIdentity, clientIdentity, sourceNode, clientNode, address,
    close: async () => {
      await Promise.allSettled([sourceNode.stop(), clientNode.stop()]);
      await rm(root, { recursive: true, force: true });
    }
  };
}
