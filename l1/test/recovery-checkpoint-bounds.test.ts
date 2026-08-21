import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publicKeyFromPrivate, addressFromPublicKey } from "../src/crypto.js";
import { ChainStore, MAX_RECOVERY_CHECKPOINT_FILE_BYTES } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivateKey = "01".padStart(64, "0");
const validatorPublicKey = publicKeyFromPrivate(validatorPrivateKey);
const validatorAddress = addressFromPublicKey(validatorPublicKey);
const activityPool = addressFromPublicKey(publicKeyFromPrivate("02".padStart(64, "0")));
const activityOracle = publicKeyFromPrivate("03".padStart(64, "0"));
const chainStoreUnsupportedOnWindows = process.platform === "win32"
  ? "ChainStore durability initialization intentionally requires POSIX directory fsync; Windows CI verifies the bounded reader primitive and production wiring instead"
  : false;

function genesis(): GenesisConfig {
  return {
    chainId: "bounded-recovery-checkpoint-test",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validatorAddress, publicKey: validatorPublicKey }],
    activityOracles: [activityOracle],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000 }]
  };
}

async function createFinalizedCheckpoint(dataDir: string): Promise<void> {
  const store = await ChainStore.open(genesis(), dataDir);
  const proposal = store.chain.produceBlock([], validatorPrivateKey, { timestampMs: genesis().timestampMs + 1 });
  const finalized = store.chain.attestBlock(proposal, validatorPrivateKey);
  await store.commitFinalizedBlock(finalized, genesis().timestampMs + 1);
  await store.writeRecoveryCheckpoint();
}

async function assertAuthoritativeReplay(dataDir: string): Promise<void> {
  const reopened = await ChainStore.open(genesis(), dataDir);
  assert.equal(reopened.chain.height, 1);
  assert.equal(reopened.recoveredFromCheckpointHeight, 0);
}

test("recovery checkpoint loader is wired to the shared bounded reader and pre-parse complexity gate", async () => {
  const source = await readFile(join(process.cwd(), "src", "storage.ts"), "utf8");
  assert.match(source, /readBoundedFileBuffer\(/);
  assert.match(source, /assertBoundedCheckpointJsonStructure\(checkpointBytes\)/);
  assert.match(source, /MAX_RECOVERY_CHECKPOINT_FILE_BYTES\s*=\s*65\s*\*\s*1024\s*\*\s*1024/);
  assert.doesNotMatch(source, /readRegularUtf8FileDescriptorBound\(join\(dataDir,\s*"recovery-checkpoint\.json"\)\)/);
});

test("oversized recovery checkpoint is rejected before allocation and finalized history remains authoritative", { skip: chainStoreUnsupportedOnWindows }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zyron-recovery-bound-"));
  try {
    await createFinalizedCheckpoint(dataDir);
    await truncate(join(dataDir, "recovery-checkpoint.json"), MAX_RECOVERY_CHECKPOINT_FILE_BYTES + 1);
    await assertAuthoritativeReplay(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("over-deep recovery checkpoint JSON is rejected before JSON.parse and finalized history remains authoritative", { skip: chainStoreUnsupportedOnWindows }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zyron-recovery-complexity-"));
  try {
    await createFinalizedCheckpoint(dataDir);
    const overDeep = "[".repeat(65) + "0" + "]".repeat(65);
    await writeFile(join(dataDir, "recovery-checkpoint.json"), overDeep, { mode: 0o600 });
    await assertAuthoritativeReplay(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
