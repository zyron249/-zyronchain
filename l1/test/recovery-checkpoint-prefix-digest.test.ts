// R21-1046-L1 option A: a recovery checkpoint binds a SHA-256 of the retained
// finalized-log prefix it skips, so ChainStore.open below the checkpoint
// detects a same-length corruption of a historical block (the line scan below
// the checkpoint never parsed those records). Legacy v1/v2 checkpoints keep
// loading through the fast path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ChainStore } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

const validatorOnePrivate = "51".padStart(64, "0");
const validatorTwoPrivate = "52".padStart(64, "0");
const alicePrivate = "53".padStart(64, "0");
const oraclePrivate = "54".padStart(64, "0");
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);
const alice = addressFromPublicKey(publicKeyFromPrivate(alicePrivate));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("56".padStart(64, "0")));

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-prefix-digest-test",
    timestampMs: 1_700_000_000_000,
    validators: [
      { address: validatorOne, publicKey: validatorOnePublic },
      { address: validatorTwo, publicKey: validatorTwoPublic }
    ],
    activityOracles: [publicKeyFromPrivate(oraclePrivate)],
    activityPool,
    allocations: [
      { address: alice, amountAtoms: 1_000_000_000 },
      { address: activityPool, amountAtoms: 5_000_000_000 }
    ]
  };
}

async function commitEmptyBlocks(store: ChainStore, through: number, firstTxs: (height: number) => unknown[] = () => []): Promise<void> {
  for (let height = store.chain.height + 1; height <= through; height += 1) {
    const proposer = height % 2 === 1 ? validatorOnePrivate : validatorTwoPrivate;
    let block = store.chain.produceBlock(firstTxs(height) as never, proposer, { timestampMs: genesis().timestampMs + (height * 100) });
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    await store.commitFinalizedBlock(block, genesis().timestampMs + (height * 100));
  }
}

/** Advances to State v2 (activation at 101), as the pruning suites do. */
async function advanceToStateV2(store: ChainStore): Promise<void> {
  await advanceToStateV2Through(store, 101);
}

async function advanceToStateV2Through(store: ChainStore, through: number): Promise<void> {
  const proposal = { chainId: genesis().chainId, nonce: 1, sender: validatorOne, activationHeight: 101, protocolVersion: 2 };
  const upgrade = createProtocolUpgrade({
    ...proposal,
    approvals: [
      createProtocolUpgradeApproval(proposal, validatorOnePrivate, validatorOnePublic),
      createProtocolUpgradeApproval(proposal, validatorTwoPrivate, validatorTwoPublic)
    ],
    timestampMs: genesis().timestampMs + 50
  }, validatorOnePrivate, validatorOnePublic);
  await commitEmptyBlocks(store, through, (height) => height === 1 ? [upgrade] : []);
}

/**
 * Same-length corruption of the stored record at `height`: flips one hex
 * character of the block hash. The line keeps its exact byte length, so the
 * checkpoint byte boundary and the tip record still match.
 */
async function corruptStoredBlockSameLength(directory: string, height: number): Promise<void> {
  const path = join(directory, "blocks.ndjson");
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim() && (JSON.parse(line) as { header: { height: number } }).header.height === height);
  assert.ok(index >= 0, `stored block ${height} not found`);
  const line = lines[index]!;
  const match = /"hash":"([0-9a-f])/.exec(line);
  assert.ok(match, "stored block has no hash field");
  const at = match.index + '"hash":"'.length;
  const flipped = match[1] === "0" ? "1" : "0";
  lines[index] = `${line.slice(0, at)}${flipped}${line.slice(at + 1)}`;
  const corrupted = lines.join("\n");
  assert.equal(Buffer.byteLength(corrupted), Buffer.byteLength(text));
  assert.notEqual(corrupted, text);
  await writeFile(path, corrupted, "utf8");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readCheckpoint(directory: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(directory, "recovery-checkpoint.json"), "utf8")) as Record<string, unknown>;
}

/** Rewrites the current checkpoint in the legacy (pre-digest) v1 or v2 layout. */
async function rewriteAsLegacy(directory: string, version: 1 | 2): Promise<void> {
  const current = await readCheckpoint(directory);
  const transition = current.transition as null | Record<string, unknown> | undefined;
  const legacy: Record<string, unknown> = version === 1
    ? {
        version: 1,
        chainId: current.chainId,
        genesisHash: current.genesisHash,
        height: current.height,
        tipHash: current.tipHash,
        blockFileBytes: current.blockFileBytes,
        snapshotSha256: current.snapshotSha256,
        snapshot: current.snapshot
      }
    : {
        version: 2,
        chainId: current.chainId,
        genesisHash: current.genesisHash,
        height: current.height,
        tipHash: current.tipHash,
        stateV2Root: current.stateV2Root,
        retainedFromHeight: current.retainedFromHeight,
        blockFileBytes: current.blockFileBytes,
        transition: transition ? { fromHeight: transition.fromHeight, blockFileBytes: transition.blockFileBytes } : null,
        snapshotSha256: current.snapshotSha256,
        snapshot: current.snapshot
      };
  await writeFile(join(directory, "recovery-checkpoint.json"), `${canonicalJson(legacy)}\n`, { mode: 0o600 });
}

test("a published checkpoint binds the SHA-256 of the exact finalized-log prefix it covers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-bind-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    await commitEmptyBlocks(store, 6);
    await store.writeRecoveryCheckpoint();
    const checkpoint = await readCheckpoint(directory);
    assert.equal(checkpoint.version, 3);
    const bytes = await readFile(join(directory, "blocks.ndjson"));
    assert.equal(checkpoint.blockFileBytes, bytes.length);
    assert.equal(checkpoint.retainedFromHeight, 1);
    assert.equal(checkpoint.transition, null);
    assert.equal(checkpoint.blockFilePrefixSha256, sha256(bytes));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an untouched log still opens through the checkpoint fast path and replays only the suffix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-clean-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    await commitEmptyBlocks(store, 8);
    await store.writeRecoveryCheckpoint();
    await commitEmptyBlocks(store, 12);
    const reopened = await ChainStore.open(genesis(), directory);
    assert.equal(reopened.recoveredFromCheckpointHeight, 8);
    assert.equal(reopened.chain.height, 12);
    assert.equal(reopened.chain.tip.hash, store.chain.tip.hash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const corruptHeight of [1, 5]) {
  test(`same-length corruption of historical block ${corruptHeight} below a checkpoint is detected on open`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-corrupt-"));
    try {
      const store = await ChainStore.open(genesis(), directory);
      await commitEmptyBlocks(store, 8);
      await store.writeRecoveryCheckpoint();
      await commitEmptyBlocks(store, 10);
      await corruptStoredBlockSameLength(directory, corruptHeight);
      // The checkpoint fast path must refuse the corrupted prefix; the
      // authoritative full replay then rejects the corrupted block itself.
      await assert.rejects(() => ChainStore.open(genesis(), directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("same-length corruption at the checkpoint tip-adjacent record below the checkpoint is detected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-tipadj-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    await commitEmptyBlocks(store, 8);
    await store.writeRecoveryCheckpoint();
    await corruptStoredBlockSameLength(directory, 7);
    await assert.rejects(() => ChainStore.open(genesis(), directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a checkpoint whose prefix digest does not match disables only the fast path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-field-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    await commitEmptyBlocks(store, 8);
    await store.writeRecoveryCheckpoint();
    const checkpoint = await readCheckpoint(directory);
    assert.equal(checkpoint.version, 3);
    checkpoint.blockFilePrefixSha256 = "00".repeat(32);
    await writeFile(join(directory, "recovery-checkpoint.json"), `${canonicalJson(checkpoint)}\n`, { mode: 0o600 });
    const reopened = await ChainStore.open(genesis(), directory);
    assert.equal(reopened.recoveredFromCheckpointHeight, 0);
    assert.equal(reopened.chain.height, 8);
    assert.equal(reopened.chain.tip.hash, store.chain.tip.hash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a v3 checkpoint with a malformed or extra field is rejected and falls back to full replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-shape-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    await commitEmptyBlocks(store, 4);
    await store.writeRecoveryCheckpoint();
    const original = await readCheckpoint(directory);
    assert.equal(original.version, 3);
    const variants: Record<string, unknown>[] = [
      { ...original, blockFilePrefixSha256: "AB".repeat(32) },
      { ...original, blockFilePrefixSha256: "ab".repeat(31) },
      { ...original, extra: true },
      { ...original, stateV2Root: "00".repeat(32) },
      { ...original, retainedFromHeight: 2 }
    ];
    for (const variant of variants) {
      await writeFile(join(directory, "recovery-checkpoint.json"), `${canonicalJson(variant)}\n`, { mode: 0o600 });
      const reopened = await ChainStore.open(genesis(), directory);
      assert.equal(reopened.recoveredFromCheckpointHeight, 0, `accepted ${Object.keys(variant).join(",")}`);
      assert.equal(reopened.chain.height, 4);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const checkpointHeight of [100, 101]) {
  test(`an unpruned checkpoint at height ${checkpointHeight} around State v2 activation binds the exact root and opens`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-v2root-"));
    try {
      const store = await ChainStore.open(genesis(), directory);
      await advanceToStateV2(store);
      if (checkpointHeight === 101) {
        await store.writeRecoveryCheckpoint();
      } else {
        const early = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-v2root-early-"));
        try {
          const partial = await ChainStore.open(genesis(), early);
          await advanceToStateV2Through(partial, 100);
          await partial.writeRecoveryCheckpoint();
          const checkpoint = await readCheckpoint(early);
          assert.equal(checkpoint.version, 3);
          assert.equal(checkpoint.stateV2Root, partial.chain.stateV2ForPersistence()?.root() ?? null);
          const reopened = await ChainStore.open(genesis(), early);
          assert.equal(reopened.recoveredFromCheckpointHeight, 100);
          assert.equal(reopened.chain.tip.hash, partial.chain.tip.hash);
        } finally {
          await rm(early, { recursive: true, force: true });
        }
        return;
      }
      const checkpoint = await readCheckpoint(directory);
      assert.equal(checkpoint.version, 3);
      assert.equal(checkpoint.retainedFromHeight, 1);
      assert.equal(checkpoint.stateV2Root, store.chain.tip.header.stateRoot);
      const reopened = await ChainStore.open(genesis(), directory);
      assert.equal(reopened.recoveredFromCheckpointHeight, 101);
      assert.equal(reopened.chain.tip.hash, store.chain.tip.hash);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("a legacy v1 checkpoint still opens through the fast path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-legacy-v1-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    await commitEmptyBlocks(store, 8);
    await store.writeRecoveryCheckpoint();
    await commitEmptyBlocks(store, 10);
    await rewriteAsLegacy(directory, 1);
    const reopened = await ChainStore.open(genesis(), directory);
    assert.equal(reopened.recoveredFromCheckpointHeight, 8);
    assert.equal(reopened.chain.height, 10);
    assert.equal(reopened.chain.tip.hash, store.chain.tip.hash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pruned history: same-length corruption inside the retained prefix is detected; a legacy v2 checkpoint still opens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-pruned-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    await advanceToStateV2(store);
    assert.deepEqual(await store.pruneFinalizedHistory({}, 20), { prunedThroughHeight: 81, firstStoredHeight: 82 });
    const checkpoint = await readCheckpoint(directory);
    assert.equal(checkpoint.version, 3);
    assert.equal(checkpoint.retainedFromHeight, 82);
    assert.equal(checkpoint.transition, null);
    const bytes = await readFile(join(directory, "blocks.ndjson"));
    assert.equal(checkpoint.blockFilePrefixSha256, sha256(bytes));

    const clean = await ChainStore.open(genesis(), directory);
    assert.equal(clean.recoveredFromCheckpointHeight, 101);
    assert.equal(clean.firstStoredHeight, 82);

    const v3Bytes = await readFile(join(directory, "recovery-checkpoint.json"));
    await rewriteAsLegacy(directory, 2);
    const legacy = await ChainStore.open(genesis(), directory);
    assert.equal(legacy.recoveredFromCheckpointHeight, 101);
    assert.equal(legacy.chain.tip.hash, store.chain.tip.hash);
    await writeFile(join(directory, "recovery-checkpoint.json"), v3Bytes);

    await corruptStoredBlockSameLength(directory, 90);
    await assert.rejects(() => ChainStore.open(genesis(), directory), /Pruned finalized history cannot fall back to full replay/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupted prune: the transition layout binds the old log prefix and detects corruption in it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-prefix-digest-transition-"));
  try {
    const store = await ChainStore.open(genesis(), directory);
    await advanceToStateV2(store);
    const fullBytes = await readFile(join(directory, "blocks.ndjson"));
    await assert.rejects(
      () => store.pruneFinalizedHistory({ afterBlockTemporarySync: () => { throw new Error("injected crash before rename"); } }, 20),
      /Pruning interrupted/
    );
    const checkpoint = await readCheckpoint(directory);
    assert.equal(checkpoint.version, 3);
    const transition = checkpoint.transition as Record<string, unknown>;
    assert.equal(transition.fromHeight, 1);
    assert.equal(transition.blockFileBytes, fullBytes.length);
    assert.equal(transition.blockFilePrefixSha256, sha256(fullBytes));
    assert.equal(await readFile(join(directory, "blocks.ndjson"), "utf8"), fullBytes.toString("utf8"));

    // Untouched old layout: opens from the transition checkpoint and resumes.
    const resumed = await ChainStore.open(genesis(), directory);
    assert.equal(resumed.recoveredFromCheckpointHeight, 101);
    assert.equal(resumed.chain.tip.hash, store.chain.tip.hash);

    await corruptStoredBlockSameLength(directory, 40);
    await assert.rejects(() => ChainStore.open(genesis(), directory), /Pruned finalized history cannot fall back to full replay/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
