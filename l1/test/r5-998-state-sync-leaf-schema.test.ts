// R5-998-M1 (independent retest, round 5; Medium per AI review, resource): a
// leaf value with canonical JSON and a recomputed value hash, but an unknown
// field, a missing field, a wrong type or an unknown account type, was only
// rejected at the final anchored assembly, so a peer could make a client
// download the whole transfer (bounded by the #1006 byte budget) first. The
// leaf-value schema must be checked in the chunk that carries the leaf, and no
// further chunk may be requested after it. Cases follow the independent
// retest's honest-prefix reproduction (honest transfer, one tampered leaf).
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { readP2PFrame, writeP2PFrame } from "../src/p2p-frame.js";
import {
  fetchTrustedPortableStateFromPeer,
  fetchTrustedPortableStateResumableFromPeer,
  MAX_STATE_RECORDS_PER_CHUNK,
  P2P_STATE_PROTOCOL,
  stateResponseMaxBytes
} from "../src/p2p-state.js";
import { createP2PNode } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import {
  createStateV2PortableBundle,
  parsePortableStateNodeRecord,
  type StateV2PortableBundleV1
} from "../src/state-v2-portable.js";
import { ChainStore, type TrustedSnapshotAnchor } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import type { Address, Block, GenesisConfig } from "../src/types.js";

const validatorPrivate = "31".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validator = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("32".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("33".padStart(64, "0")));
// Enough accounts for well over ten record chunks, so a "late" tampered leaf
// sits behind an honest prefix of at least nine chunks.
const EXTRA_ACCOUNTS = 1_400;

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-state-sync-leaf-schema-1",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validator, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [
      { address: activityPool, amountAtoms: 1_000_000 },
      ...Array.from({ length: EXTRA_ACCOUNTS }, (_, index) => ({
        address: `ZYN${(index + 1).toString(16).padStart(40, "0")}` as Address,
        amountAtoms: 0
      }))
    ]
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
type LeafRecord = Extract<StateV2PortableBundleV1["records"][number], { kind: "leaf" }>;

function withLeafValue(valueJson: string): (record: LeafRecord) => LeafRecord {
  return (record) => ({
    ...record,
    valueJson,
    valueHash: createHash("sha256").update("ZyronChain/state-v2/value\0").update(valueJson).digest("hex")
  });
}

let fixture: Fixture;
before(async () => { fixture = await createFixture("leaf-schema"); });
after(async () => { await fixture?.close(); });

/**
 * Serves the honest transfer with one tampered leaf (the first leaf, or the
 * first leaf after nine honest record chunks) and counts every request the
 * client makes after the chunk that carried it.
 */
async function transferWithTamperedLeaf(
  name: string,
  change: ((record: LeafRecord) => LeafRecord) | undefined,
  { late = false, disk = false } = {}
) {
  const records = fixture.bundle.records;
  const badAt = records.findIndex((record, index) => record.kind === "leaf" && (!late || index >= MAX_STATE_RECORDS_PER_CHUNK * 9));
  assert.ok(badAt >= 0, "fixture has a leaf at the requested position");
  let seenBad = false;
  let afterBad = 0;
  const counts = { manifest: 0, records: 0, keys: 0 };
  await fixture.sourceNode.unhandle(P2P_STATE_PROTOCOL);
  await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
    const request = await readRequest(stream);
    if (seenBad) afterBad += 1;
    counts[request.kind] += 1;
    if (request.kind === "manifest") {
      await writeFixtureResponse(stream, fixture, request);
      return;
    }
    const source = request.kind === "records" ? records : fixture.bundle.keyPreimages;
    const items: unknown[] = source.slice(request.start, request.start + request.limit);
    if (change && request.kind === "records" && request.start <= badAt && badAt < request.start + request.limit) {
      items[badAt - request.start] = change(structuredClone(records[badAt] as LeafRecord));
      seenBad = true;
    }
    await writeP2PFrame(stream, {
      version: 1, identity: peerIdentity(fixture), tipHash: fixture.anchor.tipHash,
      snapshotSha256: fixture.anchor.snapshotSha256, kind: request.kind, start: request.start, items
    }, stateResponseMaxBytes(request.kind), 5_000);
    await stream.close();
  });
  let error: unknown;
  let result: Awaited<ReturnType<typeof fetchTrustedPortableStateFromPeer>> | undefined;
  try {
    result = disk
      ? await fetchTrustedPortableStateResumableFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity,
        fixture.config, fixture.anchor, join(fixture.root, `resume-${name}`))
      : await fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity,
        fixture.config, fixture.anchor);
  } catch (caught) {
    error = caught;
  }
  return { badAt, seenBad, afterBad, counts, error, result };
}

test("R5-998-M1: the fixture spans more than ten record chunks and an honest transfer succeeds", async () => {
  assert.ok(fixture.bundle.records.length > MAX_STATE_RECORDS_PER_CHUNK * 10, `records=${fixture.bundle.records.length}`);
  const outcome = await transferWithTamperedLeaf("honest", undefined);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result?.tip.hash, fixture.anchor.tipHash);
});

const SCHEMA_CASES = [
  ["an unknown field", '{"balanceAtoms":0,"nonce":0,"surprise":1}'],
  ["a missing field", '{"balanceAtoms":0}'],
  ["a wrong type", '{"balanceAtoms":"0","nonce":0}'],
  ["an unknown account type", '{"balanceAtoms":0,"nonce":0,"type":"alien"}']
] as const;

for (const [name, valueJson] of SCHEMA_CASES) {
  test(`R5-998-M1: a leaf value with ${name} is rejected in its chunk, with no further request`, async () => {
    const outcome = await transferWithTamperedLeaf(name.replaceAll(" ", "-"), withLeafValue(valueJson));
    assert.ok(outcome.seenBad);
    assert.match(String((outcome.error as Error | undefined)?.message), /Invalid portable State v2 leaf value schema/);
    assert.equal(outcome.afterBad, 0, "no response may be requested after the offending chunk");
  });
}

test("R5-998-M1: a schema-invalid leaf after nine honest record chunks is rejected in its chunk", async () => {
  const outcome = await transferWithTamperedLeaf("late-unknown", withLeafValue('{"balanceAtoms":0,"nonce":0,"surprise":1}'), { late: true });
  assert.ok(outcome.seenBad);
  assert.ok(outcome.badAt >= MAX_STATE_RECORDS_PER_CHUNK * 9);
  assert.match(String((outcome.error as Error | undefined)?.message), /Invalid portable State v2 leaf value schema/);
  assert.equal(outcome.afterBad, 0, "no response may be requested after the offending chunk");
  assert.ok(outcome.counts.records >= 10 && outcome.counts.keys === 0, JSON.stringify(outcome.counts));
});

for (const late of [false, true]) {
  test(`R5-998-M1: a disk-staged transfer rejects a schema-invalid ${late ? "late " : ""}leaf in its chunk`, async () => {
    const outcome = await transferWithTamperedLeaf(`disk-${late ? "late" : "first"}`,
      withLeafValue('{"balanceAtoms":0,"nonce":0,"surprise":1}'), { late, disk: true });
    assert.ok(outcome.seenBad);
    assert.match(String((outcome.error as Error | undefined)?.message), /Invalid portable State v2 leaf value schema/);
    assert.equal(outcome.afterBad, 0, "no response may be requested after the offending chunk");
  });
}

test("R5-998-M1: every honest leaf passes the per-chunk check, and invalid values of every semantic type fail it", () => {
  const leaf = fixture.bundle.records.find((record) => record.kind === "leaf") as LeafRecord;
  for (const record of fixture.bundle.records) assert.doesNotThrow(() => parsePortableStateNodeRecord(record));
  const kinds = new Set(fixture.bundle.records.filter((record) => record.kind === "leaf")
    .map((record) => Object.keys(JSON.parse((record as LeafRecord).valueJson)).sort().join(",")));
  for (const shape of ["balanceAtoms,nonce", "protocolVersion", "validators"]) assert.ok(kinds.has(shape), `fixture has a ${shape} leaf`);
  for (const valueJson of [
    "null", "1", '"x"', "[]", "{}", "true",
    '{"balanceAtoms":-1,"nonce":0}', '{"balanceAtoms":1.5,"nonce":0}', '{"balanceAtoms":0,"nonce":-1}',
    '{"balanceAtoms":9007199254740992,"nonce":0}', '{"balanceAtoms":0,"nonce":"0"}', '{"nonce":0}',
    '{"settled":false}', '{"settled":1}', '{"settled":true,"x":1}',
    '{"validators":{}}', '{"validators":"x"}', '{"validators":[],"x":1}',
    '{"protocolVersion":0}', '{"protocolVersion":1.5}', '{"protocolVersion":"2"}', '{"protocolVersion":2,"x":1}'
  ]) {
    // Values the canonical encoder already refuses (non-integer or unsafe
    // numbers) fail with the canonical-encoding error; every other one with
    // the schema error.
    assert.throws(() => parsePortableStateNodeRecord(withLeafValue(valueJson)(leaf)),
      /^Error: Invalid portable State v2 leaf value( schema)?$/, valueJson);
  }
  for (const valueJson of ['{"balanceAtoms":0,"nonce":0}', '{"settled":true}', '{"protocolVersion":1}', '{"protocolVersion":65535}']) {
    assert.doesNotThrow(() => parsePortableStateNodeRecord(withLeafValue(valueJson)(leaf)), valueJson);
  }
});

// Codex review of #1010 (P2 x2): a validator-schedule leaf must carry 1 to 100
// well-formed, distinct validators whose address derives from the public key,
// and a protocol-schedule leaf a version of at most 65,535, as checkpoint
// validation requires; otherwise the rest of the transfer was still fetched.
test("R5-998-M1: validator-schedule and protocol-schedule leaves are held to the checkpoint bounds per chunk", async () => {
  const leaf = fixture.bundle.records.find((record) => record.kind === "leaf") as LeafRecord;
  const real = { address: validator, publicKey: validatorPublic };
  const other = { address: addressFromPublicKey(publicKeyFromPrivate("34".padStart(64, "0"))), publicKey: publicKeyFromPrivate("34".padStart(64, "0")) };
  const value = (validators: unknown) => canonicalJson({ validators });
  for (const [name, valueJson] of [
    ["empty validator list", value([])],
    ["non-object validator", value([1])],
    ["validator with an extra field", value([{ ...real, weight: 1 }])],
    ["validator missing its public key", value([{ address: real.address }])],
    ["validator with a malformed address", value([{ ...real, address: "ZYN" + "g".repeat(40) }])],
    ["validator with a malformed public key", value([{ ...real, publicKey: "zz".repeat(32) }])],
    ["validator whose address does not derive from its key", value([{ address: other.address, publicKey: real.publicKey }])],
    ["duplicate validator", value([real, real])],
    ["101 validators", value(Array.from({ length: 101 }, () => real))],
    ["protocol version above 65535", '{"protocolVersion":65536}']
  ] as const) {
    const outcome = await transferWithTamperedLeaf(`codex-${name.replaceAll(" ", "-")}`, withLeafValue(valueJson));
    assert.ok(outcome.seenBad, name);
    assert.match(String((outcome.error as Error | undefined)?.message), /Invalid portable State v2 leaf value schema/, name);
    assert.equal(outcome.afterBad, 0, `${name}: no response may be requested after the offending chunk`);
  }
  for (const validators of [[real], [real, other]]) {
    assert.doesNotThrow(() => parsePortableStateNodeRecord(withLeafValue(value(validators))(leaf)), JSON.stringify(validators));
  }
});

// Residual (documented): a value that is valid for another semantic type (for
// example an activity value under an account key) cannot be bound to its key
// before the key preimages arrive; it is still rejected fail-closed by the
// final anchored assembly, within the #1006 byte budget.
test("R5-998-M1 residual: a well-formed value of another semantic type still fails closed at final assembly", async () => {
  const outcome = await transferWithTamperedLeaf("cross-type", withLeafValue('{"settled":true}'));
  assert.ok(outcome.seenBad);
  assert.ok(outcome.error instanceof Error);
  assert.equal(outcome.result, undefined);
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
  const root = await mkdtemp(join(tmpdir(), `zyron-leaf-schema-${name}-`));
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

// R6-1010-M1 (independent retest, round 6; Medium per AI review, resource): the
// residual above let a peer substitute a well-formed value of another semantic
// type, or alter a valid value, and still make the client download the whole
// transfer before the final anchored assembly rejected it. Records are now
// fetched from the root down and every record is checked against the anchored
// state root (its hash and its position) in the chunk that carries it, so no
// further chunk may be requested after a record that does not belong to the
// anchored tree, even when the peer recomputes every ancestor hash.
const R6_EMPTY_HASHES = (() => {
  const domain = (name: string) => Buffer.from(`ZyronChain/state-v2/${name}\0`, "utf8");
  const hashes: string[] = new Array(257);
  hashes[256] = createHash("sha256").update(domain("empty-leaf")).digest("hex");
  for (let depth = 255; depth >= 0; depth -= 1) hashes[depth] = r6Branch(hashes[depth + 1]!, hashes[depth + 1]!);
  return hashes;
})();

function r6Branch(left: string, right: string): string {
  return createHash("sha256").update(Buffer.from("ZyronChain/state-v2/branch\0", "utf8"))
    .update(Buffer.from(left, "hex")).update(Buffer.from(right, "hex")).digest("hex");
}

function r6LeafAtDepth(keyHash: string, valueHash: string, depth: number): string {
  const key = Buffer.from(keyHash, "hex");
  let hash = createHash("sha256").update(Buffer.from("ZyronChain/state-v2/leaf\0", "utf8"))
    .update(key).update(Buffer.from(valueHash, "hex")).digest("hex");
  for (let cursor = 255; cursor >= depth; cursor -= 1) {
    const bit = (key[Math.floor(cursor / 8)]! >> (7 - (cursor % 8))) & 1;
    hash = bit === 0 ? r6Branch(hash, R6_EMPTY_HASHES[cursor + 1]!) : r6Branch(R6_EMPTY_HASHES[cursor + 1]!, hash);
  }
  return hash;
}

type R6Record = StateV2PortableBundleV1["records"][number];

/** The honest records with one leaf value changed and, optionally, every ancestor hash recomputed. */
function r6Tampered(valueJson: string, { recomputeAncestors = false, late = false } = {}): { records: R6Record[]; changed: Set<number> } {
  const records = structuredClone(fixture.bundle.records) as R6Record[];
  const index = new Map(records.map((record, at) => [record.hash, at]));
  const depth = new Map<number, number>();
  const parent = new Map<number, number>();
  const visit = (hash: string | null, at: number, from: number | undefined) => {
    if (hash === null) return;
    const position = index.get(hash);
    assert.ok(position !== undefined);
    depth.set(position, at);
    if (from !== undefined) parent.set(position, from);
    const record = records[position]!;
    if (record.kind === "branch") { visit(record.leftHash, at + 1, position); visit(record.rightHash, at + 1, position); }
  };
  visit(fixture.bundle.root, 0, undefined);
  const leafAt = records.findIndex((record, at) => record.kind === "leaf" &&
    JSON.parse(record.valueJson).balanceAtoms !== undefined && (!late || at >= MAX_STATE_RECORDS_PER_CHUNK * 9));
  assert.ok(leafAt >= 0);
  const changed = new Set<number>([leafAt]);
  const leaf = withLeafValue(valueJson)(records[leafAt] as LeafRecord);
  records[leafAt] = leaf;
  if (recomputeAncestors) {
    let oldHash = leaf.hash;
    let newHash = r6LeafAtDepth(leaf.keyHash, leaf.valueHash, depth.get(leafAt)!);
    leaf.hash = newHash;
    for (let at = parent.get(leafAt); at !== undefined; at = parent.get(at)) {
      const branch = records[at] as Extract<R6Record, { kind: "branch" }>;
      if (branch.leftHash === oldHash) branch.leftHash = newHash;
      else branch.rightHash = newHash;
      oldHash = branch.hash;
      const d = depth.get(at)!;
      newHash = r6Branch(branch.leftHash ?? R6_EMPTY_HASHES[d + 1]!, branch.rightHash ?? R6_EMPTY_HASHES[d + 1]!);
      branch.hash = newHash;
      changed.add(at);
    }
  }
  return { records, changed };
}

async function r6Transfer(name: string, records: R6Record[], changed: Set<number>, { disk = false } = {}) {
  let seenBad = false;
  let afterBad = 0;
  const counts = { manifest: 0, records: 0, keys: 0 };
  await fixture.sourceNode.unhandle(P2P_STATE_PROTOCOL);
  await fixture.sourceNode.handle(P2P_STATE_PROTOCOL, async (stream) => {
    const request = await readRequest(stream);
    if (seenBad) afterBad += 1;
    counts[request.kind] += 1;
    if (request.kind !== "records") {
      await writeFixtureResponse(stream, fixture, request);
      return;
    }
    for (let at = request.start; at < request.start + request.limit; at += 1) if (changed.has(at)) seenBad = true;
    await writeChunk(stream, fixture, request, records.slice(request.start, request.start + request.limit));
  });
  let error: unknown;
  try {
    if (disk) {
      await fetchTrustedPortableStateResumableFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity,
        fixture.config, fixture.anchor, join(fixture.root, `resume-r6-${name}`));
    } else {
      await fetchTrustedPortableStateFromPeer(fixture.clientNode, fixture.address, fixture.clientIdentity,
        fixture.config, fixture.anchor);
    }
  } catch (caught) {
    error = caught;
  }
  return { seenBad, afterBad, counts, error };
}

for (const disk of [false, true]) {
  for (const [name, valueJson, options] of [
    ["a well-formed value of another semantic type", '{"settled":true}', {}],
    ["an altered valid account value", '{"balanceAtoms":7,"nonce":3}', {}],
    ["an altered value behind nine honest chunks", '{"balanceAtoms":7,"nonce":3}', { late: true }],
    ["another semantic type with every ancestor hash recomputed", '{"settled":true}', { recomputeAncestors: true }],
    ["an altered value with every ancestor hash recomputed", '{"balanceAtoms":7,"nonce":3}', { recomputeAncestors: true, late: true }]
  ] as const) {
    test(`R6-1010-M1: ${name} is rejected against the anchored root in its chunk (${disk ? "disk" : "memory"})`, async () => {
      const { records, changed } = r6Tampered(valueJson, options);
      const outcome = await r6Transfer(`${disk ? "d" : "m"}-${name.replaceAll(" ", "-")}`, records, changed, { disk });
      assert.ok(outcome.seenBad, name);
      assert.match(String((outcome.error as Error | undefined)?.message),
        /Portable State v2 record does not match the anchored state root/, name);
      assert.equal(outcome.afterBad, 0, `${name}: no response may be requested after the offending chunk`);
      assert.equal(outcome.counts.keys, 0, JSON.stringify(outcome.counts));
    });
  }
}

test("R6-1010-M1: an honest transfer still succeeds in both modes after root-anchored checking", async () => {
  for (const disk of [false, true]) {
    const outcome = await r6Transfer(`honest-${disk}`, fixture.bundle.records, new Set(), { disk });
    assert.equal(outcome.error, undefined, String(outcome.error));
  }
});
