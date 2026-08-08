import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ChainStore } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

const validatorOnePrivate = "01".padStart(64, "0");
const validatorTwoPrivate = "02".padStart(64, "0");
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);

const genesis: GenesisConfig = {
  chainId: "zyron-restart-benchmark",
  timestampMs: 1_700_000_000_000,
  validators: [
    { address: validatorOne, publicKey: validatorOnePublic },
    { address: validatorTwo, publicKey: validatorTwoPublic }
  ],
  activityOracles: [validatorOnePublic],
  activityPool: validatorOne,
  allocations: [{ address: validatorOne, amountAtoms: 1_000_000_000 }]
};

const blockCount = parsePositiveInteger(process.env.ZYRON_BENCH_BLOCKS ?? "500", "ZYRON_BENCH_BLOCKS");
const checkpointHeight = Math.max(1, Math.floor(blockCount * 0.9));
const directory = await mkdtemp(join(tmpdir(), "zyron-restart-bench-"));

try {
  const store = await ChainStore.open(genesis, directory);
  for (let height = 1; height <= blockCount; height += 1) {
    const proposerKey = height % 2 === 1 ? validatorOnePrivate : validatorTwoPrivate;
    let block = store.chain.produceBlock([], proposerKey, {
      timestampMs: genesis.timestampMs + (height * 100)
    });
    block = store.chain.attestBlock(block, validatorOnePrivate);
    block = store.chain.attestBlock(block, validatorTwoPrivate);
    await store.commitFinalizedBlock(block, genesis.timestampMs + (height * 100));
    if (height === checkpointHeight) await store.writeRecoveryCheckpoint();
  }
  const expectedTip = store.chain.tip.hash;
  const checkpointPath = join(directory, "recovery-checkpoint.json");
  const heldCheckpointPath = join(directory, "recovery-checkpoint.bench-hold");

  await rename(checkpointPath, heldCheckpointPath);
  const fullStarted = performance.now();
  const full = await ChainStore.open(genesis, directory);
  const fullReplayMs = performance.now() - fullStarted;
  await rename(heldCheckpointPath, checkpointPath);

  const checkpointStarted = performance.now();
  const checkpointed = await ChainStore.open(genesis, directory);
  const checkpointReplayMs = performance.now() - checkpointStarted;
  if (full.chain.tip.hash !== expectedTip || checkpointed.chain.tip.hash !== expectedTip) {
    throw new Error("Restart benchmark correctness check failed");
  }
  if (checkpointed.recoveredFromCheckpointHeight !== checkpointHeight) {
    throw new Error("Restart benchmark did not use the expected checkpoint");
  }

  console.log(JSON.stringify({
    blockCount,
    checkpointHeight,
    fullReplayMs: Number(fullReplayMs.toFixed(2)),
    checkpointReplayMs: Number(checkpointReplayMs.toFixed(2)),
    speedup: Number((fullReplayMs / Math.max(checkpointReplayMs, 0.01)).toFixed(2)),
    tipHash: expectedTip
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large`);
  return parsed;
}
