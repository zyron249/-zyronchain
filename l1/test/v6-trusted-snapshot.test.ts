// NEW-R1 regression: protocol v6 finalized tips must be accepted by every
// trusted snapshot / checkpoint path using the v6 commit certificate (the same
// rule as live block acceptance), forged or insufficient certificates must be
// rejected on every path, v1-v5 behaviour must be unchanged, and replacing a
// recovery checkpoint must never destroy the previous verified one before the
// new one has been verified.
import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlockAttestation, expectedValidator } from "../src/block.js";
import { ZyronChain, type ChainSnapshot, type ChainSnapshotV1 } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { V6_COMMIT_VOTE_DOMAIN, signV6, votePayload } from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeService } from "../src/node.js";
import { fetchTrustedSnapshotFromPeer, registerP2PCheckpointProtocol } from "../src/p2p-checkpoint.js";
import { fetchTrustedPortableStateFromPeer, registerP2PStateProtocol } from "../src/p2p-state.js";
import { createP2PNode } from "../src/p2p.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createStateV2PortableBundle } from "../src/state-v2-portable.js";
import { ChainStore } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import type { Block, GenesisConfig, Transaction } from "../src/types.js";

const KEYS = ["61", "62", "63", "64"].map((value) => value.padStart(64, "0"));
const OUTSIDER = "6f".padStart(64, "0");
const pub = (key: string) => publicKeyFromPrivate(key);
const addr = (key: string) => addressFromPublicKey(pub(key));
const T0 = 1_700_000_000_000;
const STEP = 1_000;

function genesis(chainId: string, keys = KEYS.slice(0, 1)): GenesisConfig {
  const pool = addressFromPublicKey(publicKeyFromPrivate("6a".padStart(64, "0")));
  return {
    chainId,
    timestampMs: T0,
    validators: keys.map((key) => ({ address: addr(key), publicKey: pub(key) })),
    activityOracles: [publicKeyFromPrivate("6b".padStart(64, "0"))],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 1_000_000 }]
  };
}

function upgrade(config: GenesisConfig, keys: string[], nonce: number, activationHeight: number, protocolVersion: number,
  transactionVersion: 1 | 2 = 1): Transaction {
  const input = { chainId: config.chainId, nonce, sender: addr(keys[0]!), activationHeight, protocolVersion };
  return createProtocolUpgrade({
    ...input,
    approvals: keys.map((key) => createProtocolUpgradeApproval(input, key, pub(key), transactionVersion)),
    timestampMs: config.timestampMs + 1
  }, keys[0]!, pub(keys[0]!), transactionVersion);
}

function v6CommitVote(block: Block, key: string, round = 0, height = block.header.height, hash = block.hash) {
  return { validator: addr(key), publicKey: pub(key), signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, height, round, hash), key) };
}

/** Produce and finalize the next block exactly as live consensus would. */
function nextFinalized(chain: ZyronChain, keys: string[], txs: Transaction[], quorum = keys.length): Block {
  const height = chain.height + 1;
  const proposer = expectedValidator(chain.validatorsAt(height), height, 0);
  const proposerKey = keys.find((key) => pub(key) === proposer.publicKey)!;
  let block = chain.produceBlock(txs, proposerKey, { timestampMs: T0 + height * STEP });
  const signers = keys.slice(0, quorum);
  if (block.header.version === 6) {
    block.commitRound = 0;
    block.attestations = signers.map((key) => v6CommitVote(block, key));
  } else {
    for (const key of signers) block = chain.attestBlock(block, key);
  }
  return block;
}

/** Chain whose tip is a finalized block of `version` (activation at 101). */
function chainAt(config: GenesisConfig, version: number, keys = KEYS.slice(0, 1), extra = 3): ZyronChain {
  const chain = new ZyronChain(config);
  const up = upgrade(config, keys, 1, 101, version);
  for (let height = 1; height <= 100 + extra; height += 1) {
    const block = nextFinalized(chain, keys, height === 1 ? [up] : []);
    chain.acceptBlock(block, block.header.timestampMs);
  }
  return chain;
}

async function storeAt(config: GenesisConfig, dir: string, version: number, extra = 3): Promise<ChainStore> {
  const keys = KEYS.slice(0, 1);
  const store = await ChainStore.open(config, dir);
  const up = upgrade(config, keys, 1, 101, version);
  for (let height = 1; height <= 100 + extra; height += 1) {
    const block = nextFinalized(store.chain, keys, height === 1 ? [up] : []);
    await store.commitFinalizedBlock(block, block.header.timestampMs);
  }
  return store;
}

const anchorOf = (snapshot: unknown) => ({
  tipHash: (snapshot as ChainSnapshotV1).tip.hash,
  snapshotSha256: sha256Hex(canonicalJson(snapshot))
});

function portable(chain: ZyronChain, snapshot = chain.snapshot()) {
  return createStateV2PortableBundle(chain.stateV2ForPersistence()!, snapshot.state, {
    validatorSchedule: snapshot.validatorSchedule,
    protocolSchedule: snapshot.protocolSchedule
  });
}

/** Ways a v6 tip's finality evidence can be wrong while header/proposer stay valid. */
function forgedV6Tips(tip: Block, keys: string[]): Array<[string, Block, RegExp]> {
  const make = (mutate: (block: Block) => void): Block => {
    const copy = structuredClone(tip);
    mutate(copy);
    return copy;
  };
  return [
    ["no commit votes", make((b) => { b.attestations = []; }), /Finality quorum not reached: 0\/1/],
    ["missing commit round", make((b) => { b.commitRound = null; }), /requires a commit round/],
    ["vote by non-validator", make((b) => { b.attestations = [v6CommitVote(b, OUTSIDER)]; }), /Unknown Finality validator/],
    ["corrupted signature", make((b) => {
      b.attestations = b.attestations.map((vote) => ({ ...vote, signature: vote.signature.replace(/^./, (c) => (c === "0" ? "1" : "0")) }));
    }), /Invalid Finality signature/],
    ["vote for another block hash", make((b) => { b.attestations = keys.map((key) => v6CommitVote(b, key, 0, b.header.height, "ab".repeat(32))); }), /Invalid Finality signature/],
    ["vote for another height", make((b) => { b.attestations = keys.map((key) => v6CommitVote(b, key, 0, b.header.height + 1)); }), /Invalid Finality signature/],
    ["commit round differs from signed round", make((b) => { b.commitRound = 1; }), /Invalid Finality signature/],
    ["duplicate votes", make((b) => { b.attestations = [b.attestations[0]!, b.attestations[0]!]; }), /Finality exceeds active validator set|Duplicate Finality/],
    ["legacy attestation instead of commit certificate", make((b) => {
      b.commitRound = null;
      b.attestations = keys.map((key) => createBlockAttestation(b, key, pub(key))) as unknown as Block["attestations"];
    }), /requires a commit round/],
    ["round skip certificate on a v6 tip", make((b) => {
      b.roundCertificate = [{ validator: addr(keys[0]!), publicKey: pub(keys[0]!), signature: "00".repeat(64) }] as unknown as Block["roundCertificate"];
    }), /round skip/i]
  ];
}

function withTip(snapshot: ChainSnapshot, tip: Block): ChainSnapshot {
  return { ...structuredClone(snapshot), tip: structuredClone(tip) };
}

test("v6 finalized tip is accepted by fromTrustedSnapshot and fromTrustedPortableState", () => {
  const config = genesis("zyron-v6-snapshot-1");
  const chain = chainAt(config, 6);
  assert.equal(chain.tip.header.version, 6);
  const snapshot = chain.snapshot();
  const restored = ZyronChain.fromTrustedSnapshot(config, snapshot, anchorOf(snapshot));
  assert.equal(restored.tip.hash, chain.tip.hash);
  assert.equal(restored.height, chain.height);
  const fromPortable = ZyronChain.fromTrustedPortableState(config, chain.tip, portable(chain), anchorOf(snapshot));
  assert.equal(fromPortable.tip.hash, chain.tip.hash);
  // The restored chain keeps following live v6 consensus.
  const next = nextFinalized(restored, KEYS.slice(0, 1), []);
  restored.acceptBlock(next, next.header.timestampMs);
  assert.equal(restored.height, chain.height + 1);
});

test("v6 tip with a 3-of-4 commit certificate is accepted; 2-of-4 is rejected", () => {
  const keys = KEYS.slice(0, 4);
  const config = genesis("zyron-v6-snapshot-quorum-1", keys);
  const chain = chainAt(config, 6, keys, 1);
  assert.equal(chain.tip.header.version, 6);
  const tip = structuredClone(chain.tip);
  tip.attestations = tip.attestations.slice(0, 3);
  const ok = withTip(chain.snapshot(), tip);
  assert.equal(ZyronChain.fromTrustedSnapshot(config, ok, anchorOf(ok)).tip.hash, tip.hash);
  tip.attestations = tip.attestations.slice(0, 2);
  const short = withTip(chain.snapshot(), tip);
  assert.throws(() => ZyronChain.fromTrustedSnapshot(config, short, anchorOf(short)), /Finality quorum not reached: 2\/3/);
});

test("v6 tip with forged, insufficient or mismatched finality evidence is rejected by snapshot and portable paths", () => {
  const config = genesis("zyron-v6-snapshot-forged-1");
  const keys = KEYS.slice(0, 1);
  const chain = chainAt(config, 6, keys);
  const base = chain.snapshot();
  for (const [label, tip, reason] of forgedV6Tips(chain.tip, keys)) {
    const forged = withTip(base, tip);
    assert.throws(() => ZyronChain.fromTrustedSnapshot(config, forged, anchorOf(forged)), reason, `snapshot: ${label}`);
    assert.throws(() => ZyronChain.fromTrustedPortableState(config, tip, portable(chain), anchorOf(forged)), reason, `portable: ${label}`);
  }
});

test("v6 tip header version must match the protocol schedule", () => {
  const config = genesis("zyron-v6-snapshot-version-1");
  const keys = KEYS.slice(0, 1);
  const chain = chainAt(config, 6, keys);
  // Claim the v6 tip height is still governed by v5.
  const snapshot = chain.snapshot();
  const tampered = structuredClone(snapshot);
  tampered.protocolSchedule = tampered.protocolSchedule.map((entry) =>
    entry.protocolVersion === 6 ? { ...entry, protocolVersion: 5 } : entry);
  assert.throws(() => ZyronChain.fromTrustedSnapshot(config, tampered, anchorOf(tampered)), /tip protocol version mismatch/);
});

test("v1-v5 trusted snapshot paths are unchanged", () => {
  for (const version of [1, 2, 3, 5]) {
    const config = genesis(`zyron-v6-snapshot-legacy-${version}`);
    const keys = KEYS.slice(0, 1);
    const chain = chainAt(config, version, keys);
    assert.equal(chain.tip.header.version, version);
    const snapshot = chain.snapshot();
    assert.equal(ZyronChain.fromTrustedSnapshot(config, snapshot, anchorOf(snapshot)).tip.hash, chain.tip.hash);
    if (version >= 2) {
      assert.equal(ZyronChain.fromTrustedPortableState(config, chain.tip, portable(chain), anchorOf(snapshot)).tip.hash, chain.tip.hash);
    }
    const missing = withTip(snapshot, { ...structuredClone(chain.tip), attestations: [] });
    assert.throws(() => ZyronChain.fromTrustedSnapshot(config, missing, anchorOf(missing)), /attestation|quorum/i);
    // A v6-style commit certificate never finalizes a legacy tip.
    const v6Style = withTip(snapshot, { ...structuredClone(chain.tip), commitRound: 0, attestations: [v6CommitVote(chain.tip, keys[0]!)] });
    assert.throws(() => ZyronChain.fromTrustedSnapshot(config, v6Style, anchorOf(v6Style)), /Invalid block fields/);
  }
});

test("v6 trusted snapshot install and portable install succeed and reopen from the checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-v6-install-"));
  try {
    const config = genesis("zyron-v6-install-1");
    const chain = chainAt(config, 6);
    const snapshot = chain.snapshot();
    const installed = await ChainStore.installTrustedSnapshot(config, join(root, "snapshot"), snapshot, anchorOf(snapshot));
    assert.equal(installed.chain.tip.hash, chain.tip.hash);
    assert.equal(installed.recoveredFromCheckpointHeight, chain.height);
    const block = nextFinalized(installed.chain, KEYS.slice(0, 1), []);
    await installed.commitFinalizedBlock(block, block.header.timestampMs);
    assert.equal(installed.chain.height, chain.height + 1);

    const portableInstalled = await ChainStore.installTrustedPortableState(
      config, join(root, "portable"), chain.tip, portable(chain), anchorOf(snapshot));
    assert.equal(portableInstalled.chain.tip.hash, chain.tip.hash);
    const reopened = await ChainStore.open(config, join(root, "portable"));
    assert.equal(reopened.recoveredFromCheckpointHeight, chain.height);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forged v6 finality evidence is rejected by both installers without creating the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-v6-install-forged-"));
  try {
    const config = genesis("zyron-v6-install-forged-1");
    const keys = KEYS.slice(0, 1);
    const chain = chainAt(config, 6, keys);
    let index = 0;
    for (const [label, tip, reason] of forgedV6Tips(chain.tip, keys)) {
      const forged = withTip(chain.snapshot(), tip);
      const target = join(root, `s${index}`);
      await assert.rejects(() => ChainStore.installTrustedSnapshot(config, target, forged, anchorOf(forged)), reason, label);
      await assert.rejects(access(target));
      const portableTarget = join(root, `p${index}`);
      await assert.rejects(() => ChainStore.installTrustedPortableState(config, portableTarget, tip, portable(chain), anchorOf(forged)), reason, label);
      await assert.rejects(access(portableTarget));
      index += 1;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v6 recovery checkpoint is used on reopen; a forged one falls back to full replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-v6-recovery-"));
  try {
    const config = genesis("zyron-v6-recovery-1");
    const dir = join(root, "node");
    const store = await storeAt(config, dir, 6);
    assert.equal(store.chain.tip.header.version, 6);
    const written = await store.writeRecoveryCheckpoint();
    assert.equal(written.height, store.chain.height);
    const reopened = await ChainStore.open(config, dir);
    assert.equal(reopened.recoveredFromCheckpointHeight, store.chain.height);
    assert.equal(reopened.chain.tip.hash, store.chain.tip.hash);

    // Forge the checkpoint's finality evidence and make its own digest consistent:
    // the forged checkpoint must be ignored (never trusted), and full replay used.
    const path = join(dir, "recovery-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8")) as { snapshot: ChainSnapshotV1; snapshotSha256: string };
    checkpoint.snapshot.tip.attestations = [v6CommitVote(checkpoint.snapshot.tip, OUTSIDER)];
    checkpoint.snapshotSha256 = sha256Hex(canonicalJson(checkpoint.snapshot));
    await writeFile(path, `${canonicalJson(checkpoint)}\n`);
    const replayed = await ChainStore.open(config, dir);
    assert.equal(replayed.recoveredFromCheckpointHeight, 0);
    assert.equal(replayed.chain.tip.hash, store.chain.tip.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v5 recovery checkpoint reopen is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-v5-recovery-"));
  try {
    const config = genesis("zyron-v5-recovery-1");
    const dir = join(root, "node");
    const store = await storeAt(config, dir, 5);
    await store.writeRecoveryCheckpoint();
    const reopened = await ChainStore.open(config, dir);
    assert.equal(reopened.recoveredFromCheckpointHeight, store.chain.height);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function v5PrunedThenV6(config: GenesisConfig, dir: string) {
  const keys = KEYS.slice(0, 1);
  const store = await ChainStore.open(config, dir);
  const commitTo = async (target: number) => {
    while (store.chain.height < target) {
      const height = store.chain.height + 1;
      const txs = height === 1 ? [upgrade(config, keys, 1, 101, 5)] : height === 102 ? [upgrade(config, keys, 2, 202, 6, 2)] : [];
      const block = nextFinalized(store.chain, keys, txs);
      await store.commitFinalizedBlock(block, block.header.timestampMs);
    }
  };
  await commitTo(120);
  assert.equal(store.chain.tip.header.version, 5);
  await store.pruneFinalizedHistory();
  return { store, commitTo };
}

test("prune under v5, activate v6, prune again and restart (operator prune path)", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-v6-prune-"));
  try {
    const config = genesis("zyron-v6-prune-1");
    const dir = join(root, "node");
    const { store, commitTo } = await v5PrunedThenV6(config, dir);
    await commitTo(215);
    assert.equal(store.chain.tip.header.version, 6);
    const result = await store.pruneFinalizedHistory();
    assert.equal(result.prunedThroughHeight, 215);
    const reopened = await ChainStore.open(config, dir);
    assert.equal(reopened.chain.height, 215);
    assert.equal(reopened.chain.tip.hash, store.chain.tip.hash);
    assert.equal(reopened.recoveredFromCheckpointHeight, 215);
    const block = nextFinalized(reopened.chain, KEYS.slice(0, 1), []);
    await reopened.commitFinalizedBlock(block, block.header.timestampMs);
    assert.equal(reopened.chain.height, 216);

    // Explicit checkpoint publication after v6 activation also restarts.
    await reopened.writeRecoveryCheckpoint();
    const again = await ChainStore.open(config, dir);
    assert.equal(again.recoveredFromCheckpointHeight, 216);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint replacement keeps the previous verified checkpoint when the new one fails verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-v6-prune-atomic-"));
  const original = ZyronChain.fromTrustedSnapshot;
  try {
    const config = genesis("zyron-v6-prune-atomic-1");
    const dir = join(root, "node");
    const { store, commitTo } = await v5PrunedThenV6(config, dir);
    await commitTo(215);
    const path = join(dir, "recovery-checkpoint.json");
    const before = await readFile(path);

    // Simulate any verification failure of a freshly written checkpoint.
    ZyronChain.fromTrustedSnapshot = (() => { throw new Error("injected checkpoint verification failure"); }) as typeof original;
    await assert.rejects(() => store.pruneFinalizedHistory(), /checkpoint/i);
    await assert.rejects(() => store.writeRecoveryCheckpoint(), /checkpoint/i);
    ZyronChain.fromTrustedSnapshot = original;

    assert.deepEqual(await readFile(path), before, "previous verified checkpoint must be preserved byte-for-byte");
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith("recovery-checkpoint.json.")), []);
    const reopened = await ChainStore.open(config, dir);
    assert.equal(reopened.chain.height, 215);
    assert.equal(reopened.recoveredFromCheckpointHeight, 120);

    // The same live store can still prune once verification succeeds.
    const result = await store.pruneFinalizedHistory();
    assert.equal(result.prunedThroughHeight, 215);
    assert.equal((await ChainStore.open(config, dir)).recoveredFromCheckpointHeight, 215);
  } finally {
    ZyronChain.fromTrustedSnapshot = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("v6 native p2p checkpoint and portable state sync verify, install and reject forged finality", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-v6-p2p-"));
  let sourceNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  let clientNode: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const config = genesis("zyron-v6-p2p-1");
    const sourceDir = join(root, "source");
    const store = await storeAt(config, sourceDir, 6);
    assert.equal(store.chain.tip.header.version, 6);
    const snapshot = store.chain.snapshot();
    const anchor = anchorOf(snapshot);
    const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
    const clientIdentity = await loadOrCreateNodeIdentity(join(root, "client"));
    sourceNode = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    clientNode = await createP2PNode(clientIdentity);
    const service = new NodeService(store);
    await registerP2PCheckpointProtocol(sourceNode, sourceIdentity, service);
    await registerP2PStateProtocol(sourceNode, sourceIdentity, service);
    const address = sourceNode.getMultiaddrs()[0];
    assert.ok(address);

    const fetched = await fetchTrustedSnapshotFromPeer(clientNode, address, clientIdentity, config, anchor);
    assert.equal(fetched.tip.hash, anchor.tipHash);
    const installed = await ChainStore.installTrustedSnapshot(config, join(root, "installed"), fetched, anchor);
    assert.equal(installed.chain.tip.hash, anchor.tipHash);

    const state = await fetchTrustedPortableStateFromPeer(clientNode, address, clientIdentity, config, anchor);
    assert.equal(state.tip.hash, anchor.tipHash);
    const installedPortable = await ChainStore.installTrustedPortableState(
      config, join(root, "installed-portable"), state.tip, state.bundle, anchor);
    assert.equal(installedPortable.chain.tip.hash, anchor.tipHash);

    await Promise.allSettled([sourceNode.stop()]);
    sourceNode = undefined;

    // A peer serving a v6 tip whose commit certificate is forged is rejected,
    // even when the external anchor matches the forged bytes exactly.
    const forgedTip = structuredClone(store.chain.tip);
    forgedTip.attestations = [v6CommitVote(forgedTip, OUTSIDER)];
    const forgedSnapshot = withTip(snapshot, forgedTip);
    const forgedAnchor = anchorOf(forgedSnapshot);
    store.chain.snapshot = () => structuredClone(forgedSnapshot);
    Object.defineProperty(store.chain, "tip", { get: () => structuredClone(forgedTip), configurable: true });
    const forgedIdentity = await loadOrCreateNodeIdentity(join(root, "forged-source"));
    sourceNode = await createP2PNode(forgedIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
    await registerP2PCheckpointProtocol(sourceNode, forgedIdentity, new NodeService(store));
    await registerP2PStateProtocol(sourceNode, forgedIdentity, new NodeService(store));
    const forgedAddress = sourceNode.getMultiaddrs()[0];
    assert.ok(forgedAddress);
    await assert.rejects(() => fetchTrustedSnapshotFromPeer(clientNode!, forgedAddress, clientIdentity, config, forgedAnchor), /Unknown Finality validator/);
    await assert.rejects(() => fetchTrustedPortableStateFromPeer(clientNode!, forgedAddress, clientIdentity, config, forgedAnchor), (error: Error) => /Unknown Finality validator/.test(String((error.cause as Error | undefined)?.message ?? error.message)));
  } finally {
    await Promise.allSettled([sourceNode?.stop(), clientNode?.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});
