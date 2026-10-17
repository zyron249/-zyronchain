// F-09(b) residual (independent retest, round 2): a state-sync client must
// reject a peer's invalid data as soon as it arrives instead of accepting the
// whole claimed transfer (up to the protocol maxima) before the final
// anchored validation. Every record and key preimage is checked for shape and,
// where it does not depend on tree position, for hash self-consistency per
// chunk; the manifest tip header must hash to the anchored tip hash.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { readP2PFrame, writeP2PFrame } from "../src/p2p-frame.js";
import {
  fetchTrustedPortableStateFromPeer,
  fetchTrustedPortableStateResumableFromPeer,
  P2P_STATE_PROTOCOL
} from "../src/p2p-state.js";
import { createP2PNode } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createStateV2PortableBundle, type StateV2PortableBundleV1 } from "../src/state-v2-portable.js";
import { ChainStore, type TrustedSnapshotAnchor } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer } from "../src/transaction.js";
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

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function manifestFrame(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    version: 1, identity: peerIdentity(fixture), tipHash: fixture.anchor.tipHash,
    snapshotSha256: fixture.anchor.snapshotSha256, height: fixture.tip.header.height,
    stateRoot: fixture.bundle.root, recordCount: fixture.bundle.records.length,
    keyCount: fixture.bundle.keyPreimages.length, tip: fixture.tip, ...overrides
  };
}

/** Serve a manifest claiming `recordCount` records, and `badRecords(start, limit)` for every records request. */
async function serveBadRecords(fixture: Fixture, recordCount: number, badRecords: (start: number, limit: number) => unknown[]): Promise<{ recordRequests: () => number }> {
  let recordRequests = 0;
  await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
    const request = await readRequest(stream);
    if (request.kind === "manifest") {
      await writeP2PFrame(stream, manifestFrame(fixture, { recordCount }), 2_500_000, 5_000);
      await stream.close();
      return;
    }
    if (request.kind === "records") {
      recordRequests += 1;
      await writeChunk(stream, fixture, request, badRecords(request.start, request.limit));
      return;
    }
    await writeChunk(stream, fixture, request, fixture.bundle.keyPreimages.slice(request.start, request.start + request.limit));
  });
  return { recordRequests: () => recordRequests };
}

for (const resumable of [false, true]) {
  const mode = resumable ? "disk-staged" : "in-memory";
  test(`F-09(b) ${mode}: a records chunk of non-record items is rejected at the first chunk`, async () => {
    const fixture = await createFixture(`early-scalar-${mode}`);
    const resumeDir = join(fixture.root, "resume");
    try {
      const served = await serveBadRecords(fixture, 640, (start, limit) => Array.from({ length: limit }, (_, index) => `not-a-record-${start + index}`));
      await assert.rejects(
        () => resumable
          ? fetchTrustedPortableStateResumableFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir)
          : fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor),
        /Invalid portable State v2 node/
      );
      assert.equal(served.recordRequests(), 1, "the transfer must stop at the first invalid chunk");
      if (resumable) assert.deepEqual(await readdir(join(resumeDir, "records")), [], "an invalid chunk must not be staged");
    } finally {
      await fixture.close();
    }
  });
}

test("F-09(b): a leaf whose value hash does not match its value is rejected at the first chunk", async () => {
  const fixture = await createFixture("early-leaf-hash");
  try {
    const leaf = fixture.bundle.records.find((record) => record.kind === "leaf");
    assert.ok(leaf && leaf.kind === "leaf");
    const served = await serveBadRecords(fixture, 640, (_start, limit) =>
      Array.from({ length: limit }, () => ({ ...leaf, valueJson: `${leaf.valueJson} ` })));
    await assert.rejects(
      () => fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor),
      /Portable State v2 leaf value hash mismatch/
    );
    assert.equal(served.recordRequests(), 1);
  } finally {
    await fixture.close();
  }
});

test("F-09(b): a branch with two children whose hash does not match them is rejected at the first chunk", async () => {
  const fixture = await createFixture("early-branch-hash");
  try {
    const branch = fixture.bundle.records.find((record) => record.kind === "branch" && record.leftHash !== null && record.rightHash !== null);
    assert.ok(branch && branch.kind === "branch");
    const served = await serveBadRecords(fixture, 640, (_start, limit) =>
      Array.from({ length: limit }, () => ({ ...branch, leftHash: branch.rightHash, rightHash: branch.leftHash })));
    await assert.rejects(
      () => fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor),
      /Portable State v2 branch hash mismatch/
    );
    assert.equal(served.recordRequests(), 1);
  } finally {
    await fixture.close();
  }
});

test("F-09(b): an invalid key preimage is rejected at the first key chunk", async () => {
  const fixture = await createFixture("early-key");
  let keyRequests = 0;
  try {
    await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
      const request = await readRequest(stream);
      if (request.kind === "manifest") {
        // P1-08: the key count is authenticated by the anchored tree and an inflated one is
        // now rejected before any key request (p1-08-authenticated-counts.test.ts), so the
        // per-chunk preimage check is exercised with the anchored count.
        await writeP2PFrame(stream, manifestFrame(fixture), 2_500_000, 5_000);
        await stream.close();
        return;
      }
      if (request.kind === "keys") {
        keyRequests += 1;
        await writeChunk(stream, fixture, request, Array.from({ length: request.limit }, () => "k".repeat(300)));
        return;
      }
      await writeFixtureResponse(stream, fixture, request);
    });
    await assert.rejects(
      () => fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor),
      /Invalid portable State v2 key preimage/
    );
    assert.equal(keyRequests, 1);
  } finally {
    await fixture.close();
  }
});

test("F-09(b): a manifest whose tip header does not hash to the anchored tip hash is rejected before staging", async () => {
  const fixture = await createFixture("early-tip-header");
  const resumeDir = join(fixture.root, "resume");
  let chunkRequests = 0;
  try {
    await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
      const request = await readRequest(stream);
      if (request.kind === "manifest") {
        const tip = structuredClone(fixture.tip);
        tip.header.height += 1;
        await writeP2PFrame(stream, manifestFrame(fixture, { tip, height: tip.header.height }), 2_500_000, 5_000);
        await stream.close();
        return;
      }
      chunkRequests += 1;
      await writeFixtureResponse(stream, fixture, request);
    });
    await assert.rejects(
      () => fetchTrustedPortableStateResumableFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir),
      /State manifest tip does not match anchored metadata/
    );
    assert.equal(chunkRequests, 0);
    await assert.rejects(() => stat(join(resumeDir, "manifest.json")), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

// Round-4 independent retest (PR980, Medium x3): these invalid inputs were only
// rejected after the whole claimed transfer had been downloaded.
for (const kind of ["bad-json-leaf", "noncanonical-leaf"] as const) {
  test(`round-4 PR980: a ${kind} with a recomputed value hash is rejected at the first chunk`, async () => {
    const fixture = await createFixture(`r4-${kind}`);
    try {
      const leaf = fixture.bundle.records.find((record) => record.kind === "leaf");
      assert.ok(leaf && leaf.kind === "leaf");
      const valueJson = kind === "bad-json-leaf" ? "x".repeat(32) : `${leaf.valueJson} `;
      const valueHash = createHash("sha256").update("ZyronChain/state-v2/value\0").update(valueJson).digest("hex");
      const served = await serveBadRecords(fixture, 640, (_start, limit) =>
        Array.from({ length: limit }, () => ({ ...leaf, valueJson, valueHash })));
      await assert.rejects(
        () => fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor),
        /portable State v2 leaf value/i
      );
      assert.equal(served.recordRequests(), 1);
    } finally {
      await fixture.close();
    }
  });
}

test("round-4 PR980: an unknown semantic key preimage is rejected at the first key chunk", async () => {
  const fixture = await createFixture("r4-unknown-key");
  let keyRequests = 0;
  try {
    await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
      const request = await readRequest(stream);
      if (request.kind === "manifest") {
        // P1-08: the key count is authenticated by the anchored tree and an inflated one is
        // now rejected before any key request (p1-08-authenticated-counts.test.ts), so the
        // per-chunk preimage check is exercised with the anchored count.
        await writeP2PFrame(stream, manifestFrame(fixture), 2_500_000, 5_000);
        await stream.close();
        return;
      }
      if (request.kind === "keys") {
        keyRequests += 1;
        await writeChunk(stream, fixture, request, Array.from({ length: request.limit }, (_, i) => `unknown:${request.start + i}`));
        return;
      }
      await writeFixtureResponse(stream, fixture, request);
    });
    await assert.rejects(
      () => fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor),
      /Unknown State v2 semantic key/
    );
    assert.equal(keyRequests, 1);
  } finally {
    await fixture.close();
  }
});

for (const kind of ["tip-signature", "tip-body"] as const) {
  test(`round-4 PR980: an anchored tip header with a bad ${kind === "tip-signature" ? "signature" : "body"} is rejected before any chunk`, async () => {
    const fixture = await createFixture(`r4-${kind}`);
    const resumeDir = join(fixture.root, "resume");
    let chunkRequests = 0;
    try {
      const tip = structuredClone(fixture.tip);
      if (kind === "tip-signature") tip.signature = "00".repeat(64);
      else {
        tip.transactions = [createTransfer({
          chainId: fixture.config.chainId, nonce: 1, sender: validator, receiver: fixture.config.activityPool!,
          amountAtoms: 1, feeAtoms: 0, timestampMs: fixture.config.timestampMs + 1
        }, validatorPrivate, validatorPublic)];
      }
      await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
        const request = await readRequest(stream);
        if (request.kind === "manifest") {
          await writeP2PFrame(stream, manifestFrame(fixture, { tip }), 2_500_000, 5_000);
          await stream.close();
          return;
        }
        chunkRequests += 1;
        await writeFixtureResponse(stream, fixture, request);
      });
      await assert.rejects(
        () => fetchTrustedPortableStateResumableFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir),
        kind === "tip-signature" ? /Invalid proposer signature/ : /Transaction Merkle root mismatch/
      );
      assert.equal(chunkRequests, 0);
    } finally {
      await fixture.close();
    }
  });
}

// Round 3 (portable state sync): the manifest's cheap anchor comparison must run
// before the expensive tip block validation (transaction signatures).
test("state sync: a forged manifest tip is rejected by the anchor comparison before its transactions are verified", async () => {
  const fixture = await createFixture("manifest-cheap-first");
  try {
    await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
      const request = await readRequest(stream);
      if (request.kind === "manifest") {
        const tip = structuredClone(fixture.tip);
        const transfer = createTransfer({
          chainId: fixture.config.chainId, nonce: 1, sender: validator, receiver: activityPool,
          amountAtoms: 1, feeAtoms: 0, timestampMs: fixture.config.timestampMs + 1
        }, validatorPrivate, validatorPublic);
        // A transaction whose signature no longer verifies, in a tip that does not hash to the anchor.
        tip.transactions = [{ ...transfer, amountAtoms: 2 }];
        tip.hash = "ff".repeat(32);
        await writeP2PFrame(stream, manifestFrame(fixture, { tip }), 2_500_000, 5_000);
        await stream.close();
        return;
      }
      await writeFixtureResponse(stream, fixture, request);
    });
    await assert.rejects(
      () => fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor),
      /State manifest tip does not match anchored metadata/
    );
  } finally {
    await fixture.close();
  }
});

// F-09(b) residual (round 3): a peer that keeps serving self-consistent data
// must not be able to hold a state sync beyond a cumulative byte budget or an
// overall time limit.
test("F-09(b): state sync stops at the cumulative byte budget", async () => {
  const fixture = await createFixture("byte-budget");
  try {
    let chunkRequests = 0;
    await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
      const request = await readRequest(stream);
      if (request.kind !== "manifest") chunkRequests += 1;
      await writeFixtureResponse(stream, fixture, request);
    });
    await assert.rejects(
      () => fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor, { maxTotalBytes: 1 }),
      /State sync byte budget exceeded/
    );
    assert.equal(chunkRequests, 0, "the manifest alone exhausts a 1-byte budget");
  } finally {
    await fixture.close();
  }
});

test("F-09(b): state sync stops at the overall time limit", async () => {
  const fixture = await createFixture("time-limit");
  try {
    await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
      const request = await readRequest(stream);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writeFixtureResponse(stream, fixture, request);
    });
    await assert.rejects(
      () => fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor, { maxDurationMs: 10 }),
      /State sync time limit exceeded/
    );
  } finally {
    await fixture.close();
  }
});

test("F-09(b): the default state-sync budgets are bounded and positive", async () => {
  const module = await import("../src/p2p-state.js") as Record<string, unknown>;
  for (const name of ["MAX_STATE_SYNC_TOTAL_BYTES", "MAX_STATE_SYNC_DURATION_MS"]) {
    const value = module[name];
    assert.ok(Number.isSafeInteger(value) && (value as number) > 0, name);
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
