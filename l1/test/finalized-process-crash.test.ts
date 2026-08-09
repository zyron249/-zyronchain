import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ZyronChain } from "../src/chain.js";
import { ChainStore } from "../src/storage.js";
import { createTransfer } from "../src/transaction.js";
import type { Block, GenesisConfig } from "../src/types.js";

const validatorOnePrivate = "11".padStart(64, "0");
const validatorTwoPrivate = "12".padStart(64, "0");
const alicePrivate = "13".padStart(64, "0");
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const alicePublic = publicKeyFromPrivate(alicePrivate);
const alice = addressFromPublicKey(alicePublic);
const bob = addressFromPublicKey(publicKeyFromPrivate("14".padStart(64, "0")));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("15".padStart(64, "0")));

test("process crash after finalized-block fsync recovers the exact tip and ledger", async () => {
  await runCrashBoundary("afterBlockSync", 1);
});

test("process crash after finalized-block write reopens to an authoritative complete prefix", async () => {
  await runCrashBoundary("afterBlockWrite", undefined);
});

async function runCrashBoundary(
  hook: "afterBlockWrite" | "afterBlockSync",
  requiredHeight: number | undefined
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `zyron-finalized-${hook}-`));
  const genesisPath = join(directory, "genesis-input.json");
  const blockPath = join(directory, "block-input.json");
  const storageUrl = pathToFileURL(join(process.cwd(), "dist/src/storage.js")).href;
  const config = genesis();
  const block = finalizedTransferBlock(config);
  await writeFile(genesisPath, JSON.stringify(config), "utf8");
  await writeFile(blockPath, JSON.stringify(block), "utf8");

  const childScript = [
    "const { readFile } = await import('node:fs/promises');",
    "const { ChainStore } = await import(process.argv[1]);",
    "const genesis = JSON.parse(await readFile(process.argv[2], 'utf8'));",
    "const block = JSON.parse(await readFile(process.argv[3], 'utf8'));",
    "const store = await ChainStore.open(genesis, process.argv[4]);",
    "const hook = process.argv[5];",
    "await store.commitFinalizedBlock(block, genesis.timestampMs + 100, {",
    "  [hook]: async () => {",
    "    process.stdout.write('boundary\\n');",
    "    await new Promise(() => undefined);",
    "  }",
    "});"
  ].join("\n");

  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    childScript,
    storageUrl,
    genesisPath,
    blockPath,
    directory,
    hook
  ], { stdio: ["ignore", "pipe", "pipe"] });

  try {
    await waitForBoundary(child);
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

    const reopened = await ChainStore.open(config, directory);
    if (requiredHeight !== undefined) assert.equal(reopened.chain.height, requiredHeight);
    else assert.ok(reopened.chain.height === 0 || reopened.chain.height === 1);

    if (reopened.chain.height === 1) {
      assert.equal(reopened.chain.tip.hash, block.hash);
      assert.equal(reopened.chain.balance(bob), 100);
      assert.equal(reopened.chain.nonce(alice), 1);
    } else {
      assert.equal(reopened.chain.balance(bob), 0);
      assert.equal(reopened.chain.nonce(alice), 0);
    }

    assert.equal(reopened.persistenceHealthy, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

function finalizedTransferBlock(config: GenesisConfig): Block {
  const chain = new ZyronChain(config);
  const transaction = createTransfer({
    chainId: config.chainId,
    nonce: 1,
    sender: alice,
    receiver: bob,
    amountAtoms: 100,
    feeAtoms: 1,
    timestampMs: config.timestampMs + 10
  }, alicePrivate, alicePublic);
  let block = chain.produceBlock([transaction], validatorOnePrivate, {
    timestampMs: config.timestampMs + 100
  });
  block = chain.attestBlock(block, validatorOnePrivate);
  block = chain.attestBlock(block, validatorTwoPrivate);
  return block;
}

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-crash-model-1",
    timestampMs: 1_700_000_000_000,
    validators: [
      { address: addressFromPublicKey(validatorOnePublic), publicKey: validatorOnePublic },
      { address: addressFromPublicKey(validatorTwoPublic), publicKey: validatorTwoPublic }
    ],
    activityOracles: [publicKeyFromPrivate("16".padStart(64, "0"))],
    activityPool,
    allocations: [
      { address: alice, amountAtoms: 1_000 },
      { address: activityPool, amountAtoms: 1_000 }
    ]
  };
}

async function waitForBoundary(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for crash boundary: ${stderr}`));
    }, 10_000);
    const onData = (chunk: Buffer): void => {
      if (chunk.toString("utf8").includes("boundary")) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Crash child exited before boundary: code=${code} signal=${signal} stderr=${stderr}`));
    };
    const onStderr = (chunk: Buffer): void => { stderr += chunk.toString("utf8"); };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
