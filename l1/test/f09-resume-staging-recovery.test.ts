// F-09 residuals (independent retest, round 2): resume staging is untrusted
// download state. Only the operator anchor (tipHash, snapshotSha256) and the
// local chain identity name the checkpoint; height, state root, tip body and
// counts all come from a peer. Staging that disagrees with a later peer on any
// peer-supplied field, or that an interrupted discard left with a gap, must be
// discarded and restarted instead of blocking honest peers forever.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeService } from "../src/node.js";
import { readP2PFrame, writeP2PFrame } from "../src/p2p-frame.js";
import {
  fetchTrustedPortableStateFromAnyPeer,
  P2P_STATE_PROTOCOL,
  registerP2PStateProtocol
} from "../src/p2p-state.js";
import { createP2PNode } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createStateV2PortableBundle, type StateV2PortableBundleV1 } from "../src/state-v2-portable.js";
import { PortableStateResumeStore } from "../src/state-v2-resume.js";
import { ChainStore, type TrustedSnapshotAnchor } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import type { Block, GenesisConfig } from "../src/types.js";

const validatorPrivate = "21".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validator = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("22".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("23".padStart(64, "0")));

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

interface RequestShape { kind: "manifest" | "records" | "keys"; start: number; limit: number }

function stagedManifest(fixture: Awaited<ReturnType<typeof createFixture>>, overrides: Partial<{ height: number; tip: Block; recordCount: number }> = {}) {
  return {
    version: 1 as const, chainId: fixture.config.chainId, genesisHash: fixture.store.chain.genesisHash,
    tipHash: fixture.anchor.tipHash, snapshotSha256: fixture.anchor.snapshotSha256,
    height: fixture.tip.header.height, stateRoot: fixture.bundle.root,
    recordCount: fixture.bundle.records.length, keyCount: fixture.bundle.keyPreimages.length, tip: fixture.tip,
    ...overrides
  };
}

async function withHonestPeer(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  run: (honestAddress: NonNullable<ReturnType<Awaited<ReturnType<typeof createP2PNode>>["getMultiaddrs"]>[number]>) => Promise<void>
): Promise<void> {
  const honestIdentity = await loadOrCreateNodeIdentity(join(fixture.root, "honest"));
  const honestNode = await createP2PNode(honestIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  try {
    await registerP2PStateProtocol(honestNode, honestIdentity, new NodeService(fixture.store));
    const honestAddress = honestNode.getMultiaddrs()[0];
    assert.ok(honestAddress);
    await run(honestAddress);
  } finally {
    await honestNode.stop();
  }
}

for (const mode of ["forged height", "altered tip signature"] as const) {
  test(`F-09: a staged manifest with ${mode === "forged height" ? "a" : "an"} ${mode} under the correct anchor does not block an honest peer`, async () => {
    const fixture = await createFixture(mode.replaceAll(" ", "-"));
    const resumeDir = join(fixture.root, "resume");
    try {
      // The first peer keeps tipHash/snapshotSha256 (the external anchor) but
      // alters peer-supplied tip fields, so its manifest is staged; it then
      // fails before sending any record.
      await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
        const request = await readRequest(stream);
        if (request.kind !== "manifest") {
          stream.abort(new Error("injected transport failure after a forged manifest"));
          return;
        }
        const tip = structuredClone(fixture.tip);
        if (mode === "forged height") tip.header.height += 1;
        else tip.signature = "00".repeat(64);
        await writeP2PFrame(stream, {
          version: 1, identity: peerIdentity(fixture), tipHash: fixture.anchor.tipHash,
          snapshotSha256: fixture.anchor.snapshotSha256, height: tip.header.height,
          stateRoot: fixture.bundle.root, recordCount: fixture.bundle.records.length,
          keyCount: fixture.bundle.keyPreimages.length, tip
        }, 2_500_000, 5_000);
        await stream.close();
      });
      await withHonestPeer(fixture, async (honestAddress) => {
        const fetched = await fetchTrustedPortableStateFromAnyPeer(
          fixture.clientNode, [fixture.address, honestAddress], fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir
        );
        assert.equal(fetched.tip.hash, fixture.anchor.tipHash);
        assert.deepEqual(fetched.bundle, fixture.bundle);
      });
    } finally {
      await fixture.close();
    }
  });
}

test("F-09: staging left with a gap by an interrupted discard is discarded and the honest download completes", async () => {
  const fixture = await createFixture("interrupted-discard");
  const resumeDir = join(fixture.root, "resume");
  try {
    // Untrusted staging from an earlier peer: two record chunks under a
    // forged count. A crash during the recursive delete removed the manifest
    // and the first chunk but left the second.
    const store = await PortableStateResumeStore.open(resumeDir, stagedManifest(fixture, { recordCount: 256 }));
    await store.putRecords(0, Array.from({ length: 128 }, () => ({ hash: "00".repeat(32) })));
    await store.putRecords(128, Array.from({ length: 128 }, () => ({ hash: "00".repeat(32) })));
    await unlink(join(resumeDir, "manifest.json"));
    await unlink(join(resumeDir, "records", "0.json"));
    assert.deepEqual(await readdir(join(resumeDir, "records")), ["128.json"]);
    await withHonestPeer(fixture, async (honestAddress) => {
      const fetched = await fetchTrustedPortableStateFromAnyPeer(
        fixture.clientNode, [honestAddress], fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir
      );
      assert.deepEqual(fetched.bundle, fixture.bundle);
    });
  } finally {
    await fixture.close();
  }
});

test("F-09: a staged manifest whose first chunk is missing (gap) is discarded and the honest download completes", async () => {
  const fixture = await createFixture("gap-with-manifest");
  const resumeDir = join(fixture.root, "resume");
  try {
    const store = await PortableStateResumeStore.open(resumeDir, stagedManifest(fixture, { recordCount: 256 }));
    await store.putRecords(0, Array.from({ length: 128 }, () => ({ hash: "00".repeat(32) })));
    await store.putRecords(128, Array.from({ length: 128 }, () => ({ hash: "00".repeat(32) })));
    await unlink(join(resumeDir, "records", "0.json"));
    await assert.rejects(() => PortableStateResumeStore.open(resumeDir, stagedManifest(fixture, { recordCount: 256 })), /gap/);
    await withHonestPeer(fixture, async (honestAddress) => {
      const fetched = await fetchTrustedPortableStateFromAnyPeer(
        fixture.clientNode, [honestAddress], fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir
      );
      assert.deepEqual(fetched.bundle, fixture.bundle);
    });
  } finally {
    await fixture.close();
  }
});

test("F-09: discard renames staging away atomically and the next open removes leftovers", async () => {
  const fixture = await createFixture("atomic-discard");
  const resumeDir = join(fixture.root, "resume");
  try {
    const store = await PortableStateResumeStore.open(resumeDir, stagedManifest(fixture));
    await store.discard();
    await assert.rejects(() => stat(resumeDir), { code: "ENOENT" });
    // A crash after the rename but before the recursive delete finished.
    const leftover = join(fixture.root, "resume.discard-interrupted");
    await mkdir(join(leftover, "records"), { recursive: true });
    await writeFile(join(leftover, "records", "128.json"), "{}\n");
    await PortableStateResumeStore.open(resumeDir, stagedManifest(fixture));
    assert.deepEqual((await readdir(fixture.root)).filter((name) => name.startsWith("resume")), ["resume"]);
  } finally {
    await fixture.close();
  }
});

test("F-09: a resume directory for a different external anchor still fails closed and is kept", async () => {
  const fixture = await createFixture("different-anchor");
  const resumeDir = join(fixture.root, "resume");
  try {
    await PortableStateResumeStore.open(resumeDir, stagedManifest(fixture));
    const before = (await stat(join(resumeDir, "manifest.json"))).mtimeMs;
    await assert.rejects(
      () => PortableStateResumeStore.open(resumeDir, { ...stagedManifest(fixture), tipHash: "cd".repeat(32) }),
      /does not match requested checkpoint/
    );
    assert.equal((await stat(join(resumeDir, "manifest.json"))).mtimeMs, before);
  } finally {
    await fixture.close();
  }
});

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
