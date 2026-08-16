import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publicKeyFromPrivate, addressFromPublicKey } from "../src/crypto.js";
import { ChainStore } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivateKey = "01".padStart(64, "0");
const validatorPublicKey = publicKeyFromPrivate(validatorPrivateKey);
const validatorAddress = addressFromPublicKey(validatorPublicKey);
const activityPool = addressFromPublicKey(publicKeyFromPrivate("02".padStart(64, "0")));
const activityOracle = publicKeyFromPrivate("03".padStart(64, "0"));

function genesis(): GenesisConfig {
  return {
    chainId: "descriptor-recovery-test",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validatorAddress, publicKey: validatorPublicKey }],
    activityOracles: [activityOracle],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000 }]
  };
}

async function createFinalizedCheckpoint(dataDir: string): Promise<void> {
  const store = await ChainStore.open(genesis(), dataDir);
  const proposal = store.chain.produceBlock([], validatorPrivateKey, {
    timestampMs: genesis().timestampMs + 1
  });
  const finalized = store.chain.attestBlock(proposal, validatorPrivateKey);
  await store.commitFinalizedBlock(finalized, genesis().timestampMs + 1);
  await store.writeRecoveryCheckpoint();
  assert.equal(store.chain.height, 1);
}

test("recovery checkpoint symlink substitution disables checkpoint fast path and preserves finalized replay", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX O_NOFOLLOW substitution regression");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "zyron-recovery-descriptor-"));
  try {
    await createFinalizedCheckpoint(dataDir);
    const checkpointPath = join(dataDir, "recovery-checkpoint.json");
    const targetPath = join(dataDir, "checkpoint-target.json");
    await rename(checkpointPath, targetPath);
    await symlink(targetPath, checkpointPath);

    const reopened = await ChainStore.open(genesis(), dataDir);
    assert.equal(reopened.chain.height, 1);
    assert.equal(reopened.recoveredFromCheckpointHeight, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("corrupt regular recovery checkpoint still falls back to authoritative finalized history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zyron-recovery-corrupt-"));
  try {
    await createFinalizedCheckpoint(dataDir);
    await writeFile(join(dataDir, "recovery-checkpoint.json"), "{not-json\n", { mode: 0o600 });

    const reopened = await ChainStore.open(genesis(), dataDir);
    assert.equal(reopened.chain.height, 1);
    assert.equal(reopened.recoveredFromCheckpointHeight, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
