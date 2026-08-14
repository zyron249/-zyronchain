import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createStateV2PortableBundle } from "../src/state-v2-portable.js";
import { PortableStateResumeStore } from "../src/state-v2-resume.js";
import { validatePortableResumeSnapshot } from "../src/state-v2-resume-trust.js";
import { ChainStore } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivate = "61".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validator = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("62".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("63".padStart(64, "0")));

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-portable-resume-trust-1",
    timestampMs: 1_700_100_000_000,
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

test("portable resume crosses the external anchor without calling bundle()", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-trust-"));
  try {
    const config = genesis();
    const source = await ChainStore.open(config, join(root, "source"));
    await advanceToStateV2(source);
    const snapshot = source.chain.snapshot();
    const state = source.chain.stateV2ForPersistence();
    assert.ok(state);
    const bundle = createStateV2PortableBundle(state, snapshot.state, {
      validatorSchedule: snapshot.validatorSchedule,
      protocolSchedule: snapshot.protocolSchedule
    });
    const anchor = { tipHash: snapshot.tip.hash, snapshotSha256: sha256Hex(canonicalJson(snapshot)) };
    const resume = await PortableStateResumeStore.open(join(root, "resume"), {
      version: 1,
      chainId: config.chainId,
      genesisHash: source.chain.genesisHash,
      tipHash: anchor.tipHash,
      snapshotSha256: anchor.snapshotSha256,
      height: snapshot.height,
      stateRoot: bundle.root,
      recordCount: bundle.records.length,
      keyCount: bundle.keyPreimages.length,
      tip: snapshot.tip
    });
    await resume.putRecords(0, bundle.records);
    await resume.putKeys(0, bundle.keyPreimages);
    assert.equal(resume.complete(), true);
    (resume as unknown as { bundle: () => Promise<never> }).bundle = async () => {
      throw new Error("bundle materialization must not be used");
    };

    const validated = await validatePortableResumeSnapshot(config, resume, anchor, join(root, "stage"));
    assert.equal(validated.stateRoot, bundle.root);
    assert.equal(validated.snapshot.tip.hash, anchor.tipHash);
    assert.equal(sha256Hex(canonicalJson(validated.snapshot)), anchor.snapshotSha256);

    const installed = await ChainStore.installTrustedSnapshot(
      config,
      join(root, "installed"),
      validated.snapshot,
      anchor
    );
    assert.equal(installed.chain.tip.hash, anchor.tipHash);
    assert.equal(installed.chain.tip.header.stateRoot, bundle.root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable resume trust bridge rejects an anchor mismatch before staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-state-trust-anchor-"));
  try {
    const config = genesis();
    const source = await ChainStore.open(config, join(root, "source"));
    await advanceToStateV2(source);
    const snapshot = source.chain.snapshot();
    const state = source.chain.stateV2ForPersistence();
    assert.ok(state);
    const bundle = createStateV2PortableBundle(state, snapshot.state, {
      validatorSchedule: snapshot.validatorSchedule,
      protocolSchedule: snapshot.protocolSchedule
    });
    const anchor = { tipHash: snapshot.tip.hash, snapshotSha256: sha256Hex(canonicalJson(snapshot)) };
    const resume = await PortableStateResumeStore.open(join(root, "resume"), {
      version: 1,
      chainId: config.chainId,
      genesisHash: source.chain.genesisHash,
      tipHash: anchor.tipHash,
      snapshotSha256: anchor.snapshotSha256,
      height: snapshot.height,
      stateRoot: bundle.root,
      recordCount: bundle.records.length,
      keyCount: bundle.keyPreimages.length,
      tip: snapshot.tip
    });
    await resume.putRecords(0, bundle.records);
    await resume.putKeys(0, bundle.keyPreimages);

    await assert.rejects(
      () => validatePortableResumeSnapshot(config, resume, {
        tipHash: anchor.tipHash,
        snapshotSha256: "00".repeat(32)
      }, join(root, "stage")),
      /external anchor identity mismatch/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
