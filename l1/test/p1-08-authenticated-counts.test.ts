// P1-08 (F-09(b) residual): the record and key-preimage counts in a state-sync
// manifest come from the serving peer. They must be authenticated by the
// operator-anchored state root, so a selected peer cannot make a client
// download more than the anchored state (plus at most one rejected chunk) by
// advertising inflated counts, nor have uncommitted or duplicate key preimages
// staged until the final assembly rejects them.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeService } from "../src/node.js";
import { readP2PFrame, writeP2PFrame } from "../src/p2p-frame.js";
import {
  fetchTrustedPortableStateFromAnyPeer,
  fetchTrustedPortableStateFromPeer,
  fetchTrustedPortableStateResumableFromPeer,
  MAX_STATE_KEYS_PER_CHUNK,
  MAX_STATE_RECORDS_PER_CHUNK,
  P2P_STATE_PROTOCOL,
  registerP2PStateProtocol
} from "../src/p2p-state.js";
import { createP2PNode } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import {
  createStateV2PortableBundle,
  MAX_PORTABLE_STATE_KEYS,
  MAX_PORTABLE_STATE_NODES,
  type StateV2PortableBundleV1
} from "../src/state-v2-portable.js";
import { PortableStateResumeStore } from "../src/state-v2-resume.js";
import { StateV2AnchoredRecordStream, type StateV2NodeRecord } from "../src/state-v2.js";
import { ChainStore, type TrustedSnapshotAnchor } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer } from "../src/transaction.js";
import type { Block, GenesisConfig } from "../src/types.js";

const validatorPrivate = "21".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validator = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("22".padStart(64, "0"));
const poolPrivate = "23".padStart(64, "0");
const poolPublic = publicKeyFromPrivate(poolPrivate);
const activityPool = addressFromPublicKey(poolPublic);
// Enough accounts that records span several 128-record chunks.
const EXTRA_ACCOUNTS = 200;
const uncommittedAccountKey = `account:${addressFromPublicKey(publicKeyFromPrivate("99".padStart(64, "0")))}`;

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-portable-state-p1-08",
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
  const transfers = Array.from({ length: EXTRA_ACCOUNTS }, (_, index) => createTransfer({
    chainId: config.chainId, nonce: index + 1, sender: activityPool,
    receiver: addressFromPublicKey(publicKeyFromPrivate((1_000 + index).toString(16).padStart(64, "0"))),
    amountAtoms: 1, feeAtoms: 0, timestampMs: config.timestampMs + 1
  }, poolPrivate, poolPublic));
  for (let height = 1; height <= 101; height += 1) {
    let block = store.chain.produceBlock(height === 1 ? [upgrade, ...transfers] : [], validatorPrivate, {
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

interface Counters { records: number; keys: number }

/**
 * A peer that serves the genuine anchored records and key preimages but
 * advertises `recordCount` / `keyCount`. Records are aligned to the end of the
 * claimed list (the client fetches root first), padded at the front with
 * genuine records; keys are served from the front, padded with `keyFiller`.
 */
async function serveWithCounts(
  fixture: Fixture,
  counts: { recordCount?: number; keyCount?: number },
  keys: (start: number, limit: number) => unknown[] = (start, limit) => paddedKeys(fixture, start, limit)
): Promise<Counters> {
  const counters: Counters = { records: 0, keys: 0 };
  const recordCount = counts.recordCount ?? fixture.bundle.records.length;
  const offset = recordCount - fixture.bundle.records.length;
  await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
    const request = await readRequest(stream);
    if (request.kind === "manifest") {
      await writeP2PFrame(stream, manifestFrame(fixture, counts), 2_500_000, 5_000);
      await stream.close();
      return;
    }
    if (request.kind === "records") {
      counters.records += 1;
      const items = Array.from({ length: request.limit }, (_, index) => {
        const position = request.start + index - offset;
        return fixture.bundle.records[Math.max(0, Math.min(fixture.bundle.records.length - 1, position))];
      });
      await writeChunk(stream, fixture, request, items);
      return;
    }
    counters.keys += 1;
    await writeChunk(stream, fixture, request, keys(request.start, request.limit));
  });
  return counters;
}

function paddedKeys(fixture: Fixture, start: number, limit: number): unknown[] {
  return Array.from({ length: limit }, (_, index) =>
    fixture.bundle.keyPreimages[start + index] ?? `account:filler-${start + index}`);
}

function fetchOnce(fixture: Fixture, resumeDir?: string) {
  return resumeDir
    ? fetchTrustedPortableStateResumableFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir)
    : fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity, fixture.config, fixture.anchor);
}

async function stagedKeyFiles(resumeDir: string): Promise<string[]> {
  try {
    return await readdir(join(resumeDir, "keys"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("P1-08 fixture: records span several chunks and the honest transfer succeeds in both modes", async () => {
  const fixture = await createFixture("honest");
  try {
    assert.ok(fixture.bundle.records.length > 2 * MAX_STATE_RECORDS_PER_CHUNK, "fixture must span several record chunks");
    assert.ok(fixture.bundle.keyPreimages.length > EXTRA_ACCOUNTS);
    const counters = await serveWithCounts(fixture, {});
    for (const resumeDir of [undefined, join(fixture.root, "resume")]) {
      const fetched = await fetchOnce(fixture, resumeDir);
      assert.equal(fetched.bundle.root, fixture.bundle.root);
      assert.deepEqual(fetched.bundle.keyPreimages, fixture.bundle.keyPreimages);
      assert.equal(fetched.bundle.records.length, fixture.bundle.records.length);
    }
    assert.ok(counters.keys > 0);
  } finally {
    await fixture.close();
  }
});

for (const resumable of [false, true]) {
  const mode = resumable ? "disk-staged" : "in-memory";

  for (const claim of ["true+5", "protocol maximum", "true-1"] as const) {
    test(`P1-08 ${mode}: a manifest key count of ${claim} is rejected before any key is requested`, async () => {
      const fixture = await createFixture(`keys-${claim.replace(/\W/g, "")}-${mode}`);
      const resumeDir = resumable ? join(fixture.root, "resume") : undefined;
      try {
        const truth = fixture.bundle.keyPreimages.length;
        const keyCount = claim === "true+5" ? truth + 5 : claim === "protocol maximum" ? MAX_PORTABLE_STATE_KEYS : truth - 1;
        const counters = await serveWithCounts(fixture, { keyCount });
        await assert.rejects(() => fetchOnce(fixture, resumeDir), /State manifest key count does not match the anchored state root/);
        assert.equal(counters.keys, 0, "no key chunk may be requested under an unauthenticated key count");
        assert.equal(counters.records, Math.ceil(fixture.bundle.records.length / MAX_STATE_RECORDS_PER_CHUNK));
        if (resumeDir) assert.deepEqual(await stagedKeyFiles(resumeDir), []);
      } finally {
        await fixture.close();
      }
    });
  }

  for (const claim of ["true+640", "protocol maximum"] as const) {
    test(`P1-08 ${mode}: a manifest record count of ${claim} cannot make the client download more than the anchored tree`, async () => {
      const fixture = await createFixture(`records-${claim.replace(/\W/g, "")}-${mode}`);
      const resumeDir = resumable ? join(fixture.root, "resume") : undefined;
      try {
        const truth = fixture.bundle.records.length;
        const recordCount = claim === "true+640" ? truth + 640 : MAX_PORTABLE_STATE_NODES;
        const counters = await serveWithCounts(fixture, { recordCount });
        await assert.rejects(() => fetchOnce(fixture, resumeDir), /Portable State v2 record does not match the anchored state root/);
        // Every genuine record, plus the one chunk that carries the first record
        // beyond the anchored tree.
        assert.ok(counters.records <= Math.ceil(truth / MAX_STATE_RECORDS_PER_CHUNK) + 1,
          `record requests ${counters.records} exceed the anchored tree`);
        assert.equal(counters.keys, 0);
      } finally {
        await fixture.close();
      }
    });
  }

  test(`P1-08 ${mode}: a manifest record count below the anchored tree is rejected before any key is requested`, async () => {
    const fixture = await createFixture(`records-short-${mode}`);
    const resumeDir = resumable ? join(fixture.root, "resume") : undefined;
    try {
      const counters = await serveWithCounts(fixture, { recordCount: fixture.bundle.records.length - 1 });
      await assert.rejects(() => fetchOnce(fixture, resumeDir), /Portable State v2 record does not match the anchored state root/);
      assert.equal(counters.keys, 0);
    } finally {
      await fixture.close();
    }
  });

  test(`P1-08 ${mode}: a well-formed key preimage that the anchored root does not commit is rejected in its chunk and not staged`, async () => {
    const fixture = await createFixture(`key-uncommitted-${mode}`);
    const resumeDir = resumable ? join(fixture.root, "resume") : undefined;
    try {
      const counters = await serveWithCounts(fixture, {}, (start, limit) =>
        paddedKeys(fixture, start, limit).map((key, index) => (start + index === 3 ? uncommittedAccountKey : key)));
      await assert.rejects(() => fetchOnce(fixture, resumeDir), /not committed by the anchored state root/);
      assert.equal(counters.keys, 1, "the transfer must stop at the chunk carrying the uncommitted preimage");
      if (resumeDir) assert.deepEqual(await stagedKeyFiles(resumeDir), [], "a rejected key chunk must not be staged");
    } finally {
      await fixture.close();
    }
  });

  test(`P1-08 ${mode}: a duplicated committed key preimage is rejected in its chunk`, async () => {
    const fixture = await createFixture(`key-duplicate-${mode}`);
    const resumeDir = resumable ? join(fixture.root, "resume") : undefined;
    try {
      const counters = await serveWithCounts(fixture, {}, (start, limit) =>
        paddedKeys(fixture, start, limit).map((key, index) => (start + index === 1 ? fixture.bundle.keyPreimages[0] : key)));
      await assert.rejects(() => fetchOnce(fixture, resumeDir), /not committed by the anchored state root \(or is a duplicate\)/);
      assert.equal(counters.keys, 1);
      if (resumeDir) assert.deepEqual(await stagedKeyFiles(resumeDir), []);
    } finally {
      await fixture.close();
    }
  });
}

test("P1-08: staged key preimages that do not match the anchored root are discarded and an honest peer then succeeds", async () => {
  const fixture = await createFixture("staged-keys");
  const resumeDir = join(fixture.root, "resume");
  const honestIdentity = await loadOrCreateNodeIdentity(join(fixture.root, "honest"));
  const honestNode = await createP2PNode(honestIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
  try {
    // Staging left by an older client that only shape-checked keys: genuine
    // root-first records and a shape-valid but uncommitted key preimage.
    const manifest = {
      version: 1 as const, chainId: fixture.config.chainId, genesisHash: fixture.store.chain.genesisHash,
      tipHash: fixture.anchor.tipHash, snapshotSha256: fixture.anchor.snapshotSha256,
      height: fixture.tip.header.height, stateRoot: fixture.bundle.root,
      recordCount: fixture.bundle.records.length, keyCount: fixture.bundle.keyPreimages.length, tip: fixture.tip
    };
    const store = await PortableStateResumeStore.open(resumeDir, manifest);
    for (let end = fixture.bundle.records.length; end > 0;) {
      const start = Math.max(0, end - MAX_STATE_RECORDS_PER_CHUNK);
      await store.putRecordsBefore(start, fixture.bundle.records.slice(start, end));
      end = start;
    }
    await store.putKeys(0, [uncommittedAccountKey, ...fixture.bundle.keyPreimages.slice(1, 4)]);

    await registerP2PStateProtocol(honestNode, honestIdentity, new NodeService(fixture.store));
    const honestAddress = honestNode.getMultiaddrs()[0];
    assert.ok(honestAddress);
    // A single attempt reports the poisoned staging and removes it ...
    await assert.rejects(
      () => fetchTrustedPortableStateResumableFromPeer(fixture.clientNode, honestAddress, fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir),
      /Staged portable state key preimages do not match the anchored state root/
    );
    await assert.rejects(() => stat(join(resumeDir, "keys", "0.json")), { code: "ENOENT" });
    // ... and the multi-peer fetch gives the same honest peer a clean retry.
    const poisoned = await PortableStateResumeStore.open(resumeDir, manifest);
    for (let end = fixture.bundle.records.length; end > 0;) {
      const start = Math.max(0, end - MAX_STATE_RECORDS_PER_CHUNK);
      await poisoned.putRecordsBefore(start, fixture.bundle.records.slice(start, end));
      end = start;
    }
    await poisoned.putKeys(0, [fixture.bundle.keyPreimages[0], fixture.bundle.keyPreimages[0]]);
    const fetched = await fetchTrustedPortableStateFromAnyPeer(
      fixture.clientNode, [honestAddress], fixture.clientIdentity, fixture.config, fixture.anchor, resumeDir
    );
    assert.equal(fetched.bundle.root, fixture.bundle.root);
    assert.deepEqual(fetched.bundle.keyPreimages, fixture.bundle.keyPreimages);
  } finally {
    await honestNode.stop();
    await fixture.close();
  }
});

test("P1-08: the anchored record stream exposes the authenticated key-preimage set only when complete", async () => {
  const fixture = await createFixture("stream-unit");
  try {
    const records = fixture.bundle.records as StateV2NodeRecord[];
    const stream = new StateV2AnchoredRecordStream(fixture.bundle.root);
    for (let index = records.length - 1; index > 0; index -= 1) stream.accept(records[index]!);
    assert.throws(() => stream.keyPreimageStream(), /incomplete/);
    stream.accept(records[0]!);
    stream.finish(records.length);
    const keys = stream.keyPreimageStream();
    assert.throws(() => stream.keyPreimageStream(), /incomplete/, "the authenticated set is handed out once");
    assert.equal(keys.total, records.filter((record) => record.kind === "leaf").length);
    assert.equal(keys.total, fixture.bundle.keyPreimages.length);
    assert.throws(() => keys.accept(uncommittedAccountKey), /not committed by the anchored state root/);
    const [first, ...rest] = fixture.bundle.keyPreimages;
    keys.accept(first!);
    assert.throws(() => keys.accept(first!), /or is a duplicate/);
    assert.throws(() => keys.finish(), /missing for anchored leaves/);
    for (const key of rest) keys.accept(key);
    keys.finish();
    assert.ok(MAX_STATE_KEYS_PER_CHUNK > 0);
  } finally {
    await fixture.close();
  }
});

function manifestFrame(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    version: 1, identity: peerIdentity(fixture), tipHash: fixture.anchor.tipHash,
    snapshotSha256: fixture.anchor.snapshotSha256, height: fixture.tip.header.height,
    stateRoot: fixture.bundle.root, recordCount: fixture.bundle.records.length,
    keyCount: fixture.bundle.keyPreimages.length, tip: fixture.tip, ...overrides
  };
}

async function readRequest(stream: Parameters<typeof readP2PFrame>[0]): Promise<RequestShape> {
  const value = await readP2PFrame(stream, 4_096, 5_000) as Record<string, unknown>;
  assert.ok(value.kind === "manifest" || value.kind === "records" || value.kind === "keys");
  assert.ok(Number.isSafeInteger(value.start));
  assert.ok(Number.isSafeInteger(value.limit));
  return { kind: value.kind, start: Number(value.start), limit: Number(value.limit) };
}

async function writeChunk(stream: Parameters<typeof writeP2PFrame>[0], fixture: Fixture, request: RequestShape, items: unknown[]): Promise<void> {
  await writeP2PFrame(stream, {
    version: 1, identity: peerIdentity(fixture), tipHash: fixture.anchor.tipHash,
    snapshotSha256: fixture.anchor.snapshotSha256, kind: request.kind,
    start: request.start, items
  }, 20 * 1024 * 1024, 5_000);
  await stream.close();
}

function peerIdentity(fixture: Fixture) {
  return {
    version: 1 as const,
    nodeId: fixture.sourceIdentity.nodeId,
    publicKey: fixture.sourceIdentity.publicKey,
    chainId: fixture.config.chainId,
    genesisHash: fixture.store.chain.genesisHash
  };
}

async function createFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `zyron-p1-08-${name}-`));
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
