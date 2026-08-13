import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ChainStore } from "../src/storage.js";
import { createTransfer } from "../src/transaction.js";
import type { Block, GenesisConfig } from "../src/types.js";

const validatorOnePrivate = "41".padStart(64, "0");
const validatorTwoPrivate = "42".padStart(64, "0");
const alicePrivate = "43".padStart(64, "0");
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const alicePublic = publicKeyFromPrivate(alicePrivate);
const alice = addressFromPublicKey(alicePublic);
const bob = addressFromPublicKey(publicKeyFromPrivate("44".padStart(64, "0")));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("45".padStart(64, "0")));

for (const delimiter of ["\r\n", ""] as const) {
  test(`replay preserves exact ${delimiter ? "CRLF" : "EOF-final"} byte boundary before next finalized append`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `zyron-offset-${delimiter ? "crlf" : "eof"}-`));
    const config = genesis();
    try {
      await ChainStore.open(config, directory);
      const [first, second] = finalizedBlocks(config);
      const firstJson = JSON.stringify(first);
      await writeFile(join(directory, "blocks.ndjson"), `${firstJson}${delimiter}`, "utf8");

      const reopened = await ChainStore.open(config, directory);
      assert.equal(reopened.chain.height, 1);
      assert.equal(reopened.chain.tip.hash, first.hash);

      await reopened.commitFinalizedBlock(second, config.timestampMs + 300);
      const blocks = await reopened.readFinalizedBlocks(1, 2, 10_000_000);
      assert.deepEqual(blocks.map((block) => block.hash), [first.hash, second.hash]);

      const checkpoint = await reopened.writeRecoveryCheckpoint();
      const bytes = (await stat(join(directory, "blocks.ndjson"))).size;
      const checkpointFile = JSON.parse(await readFile(join(directory, "recovery-checkpoint.json"), "utf8")) as {
        blockFileBytes: number;
      };
      assert.equal(checkpointFile.blockFileBytes, bytes);
      assert.equal(checkpoint.height, 2);

      const secondRestart = await ChainStore.open(config, directory);
      assert.equal(secondRestart.chain.height, 2);
      assert.equal(secondRestart.chain.tip.hash, second.hash);
      const afterRestart = await secondRestart.readFinalizedBlocks(1, 2, 10_000_000);
      assert.deepEqual(afterRestart.map((block) => block.hash), [first.hash, second.hash]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

function finalizedBlocks(config: GenesisConfig): [Block, Block] {
  const chain = new ZyronChain(config);
  const firstTx = createTransfer({
    chainId: config.chainId,
    nonce: 1,
    sender: alice,
    receiver: bob,
    amountAtoms: 100,
    feeAtoms: 1,
    timestampMs: config.timestampMs + 10
  }, alicePrivate, alicePublic);
  let first = chain.produceBlock([firstTx], validatorOnePrivate, { timestampMs: config.timestampMs + 100 });
  first = chain.attestBlock(first, validatorOnePrivate);
  first = chain.attestBlock(first, validatorTwoPrivate);
  chain.acceptBlock(first, config.timestampMs + 150);

  const secondTx = createTransfer({
    chainId: config.chainId,
    nonce: 2,
    sender: alice,
    receiver: bob,
    amountAtoms: 50,
    feeAtoms: 1,
    timestampMs: config.timestampMs + 200
  }, alicePrivate, alicePublic);
  let second = chain.produceBlock([secondTx], validatorTwoPrivate, { timestampMs: config.timestampMs + 250 });
  second = chain.attestBlock(second, validatorOnePrivate);
  second = chain.attestBlock(second, validatorTwoPrivate);
  return [first, second];
}

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-finalized-offsets-1",
    timestampMs: 1_700_000_000_000,
    validators: [
      { address: addressFromPublicKey(validatorOnePublic), publicKey: validatorOnePublic },
      { address: addressFromPublicKey(validatorTwoPublic), publicKey: validatorTwoPublic }
    ],
    activityOracles: [publicKeyFromPrivate("46".padStart(64, "0"))],
    activityPool,
    allocations: [
      { address: alice, amountAtoms: 10_000 },
      { address: activityPool, amountAtoms: 1_000 }
    ]
  };
}