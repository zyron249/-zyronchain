import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJson, sha256Hex } from "../dist/src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { ChainStore } from "../dist/src/storage.js";
import {
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer
} from "../dist/src/transaction.js";

const execFileAsync = promisify(execFile);
const l1Root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(l1Root, "dist", "src", "cli.js");

const validatorOnePrivate = "01".padStart(64, "0");
const validatorTwoPrivate = "02".padStart(64, "0");
const alicePrivate = "03".padStart(64, "0");
const oraclePrivate = "04".padStart(64, "0");
const bobPrivate = "05".padStart(64, "0");
const activityPoolPrivate = "06".padStart(64, "0");

const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const alicePublic = publicKeyFromPrivate(alicePrivate);
const oraclePublic = publicKeyFromPrivate(oraclePrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);
const alice = addressFromPublicKey(alicePublic);
const bob = addressFromPublicKey(publicKeyFromPrivate(bobPrivate));
const activityPool = addressFromPublicKey(publicKeyFromPrivate(activityPoolPrivate));

const genesis = {
  chainId: "zyron-disaster-recovery-rehearsal",
  timestampMs: 1_700_000_000_000,
  validators: [
    { address: validatorOne, publicKey: validatorOnePublic },
    { address: validatorTwo, publicKey: validatorTwoPublic }
  ],
  activityOracles: [oraclePublic],
  activityPool,
  allocations: [
    { address: alice, amountAtoms: 1_000_000_000 },
    { address: activityPool, amountAtoms: 5_000_000_000 }
  ]
};

function protocolChange(nonce, activationHeight, protocolVersion, timestampMs) {
  const proposal = {
    chainId: genesis.chainId,
    nonce,
    sender: validatorOne,
    activationHeight,
    protocolVersion
  };
  return createProtocolUpgrade({
    ...proposal,
    approvals: [
      createProtocolUpgradeApproval(proposal, validatorOnePrivate, validatorOnePublic),
      createProtocolUpgradeApproval(proposal, validatorTwoPrivate, validatorTwoPublic)
    ],
    timestampMs
  }, validatorOnePrivate, validatorOnePublic);
}

function proposerPrivateKey(height) {
  return height % 2 === 1 ? validatorOnePrivate : validatorTwoPrivate;
}

async function commitHeight(store, height, transactions = []) {
  const timestampMs = genesis.timestampMs + (height * 100);
  let block = store.chain.produceBlock(transactions, proposerPrivateKey(height), { timestampMs });
  block = store.chain.attestBlock(block, validatorOnePrivate);
  block = store.chain.attestBlock(block, validatorTwoPrivate);
  await store.commitFinalizedBlock(block, timestampMs);
  return structuredClone(block);
}

function transfer(nonce, amountAtoms, height, version) {
  return createTransfer({
    chainId: genesis.chainId,
    nonce,
    sender: alice,
    receiver: bob,
    amountAtoms,
    feeAtoms: 0,
    timestampMs: genesis.timestampMs + (height * 100) - 1
  }, alicePrivate, alicePublic, version);
}

function assertSnapshotEquivalent(actual, expected, label) {
  assert.equal(actual.height, expected.height, `${label}: height mismatch`);
  assert.equal(actual.tip.hash, expected.tip.hash, `${label}: tip mismatch`);
  assert.equal(actual.tip.header.stateRoot, expected.tip.header.stateRoot, `${label}: state-root mismatch`);
  assert.equal(canonicalJson(actual.state), canonicalJson(expected.state), `${label}: ledger snapshot mismatch`);
  assert.equal(canonicalJson(actual.validatorSchedule), canonicalJson(expected.validatorSchedule), `${label}: validator schedule mismatch`);
  assert.equal(canonicalJson(actual.protocolSchedule), canonicalJson(expected.protocolSchedule), `${label}: protocol schedule mismatch`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const root = await mkdtemp(join(tmpdir(), "zyron-dr-rehearsal-"));
const genesisPath = join(root, "genesis.json");
const sourceDir = join(root, "source-data");
const checkpointPath = join(root, "checkpoint.json");
const rejectedDir = join(root, "rejected-restore");
const restoredDir = join(root, "restored-data");

try {
  await writeFile(genesisPath, `${JSON.stringify(genesis, null, 2)}\n`, { mode: 0o644 });

  const source = await ChainStore.open(genesis, sourceDir);
  const upgradeToV2 = protocolChange(1, 101, 2, genesis.timestampMs + 1);
  const upgradeToV3 = protocolChange(2, 201, 3, genesis.timestampMs + 2);

  for (let height = 1; height <= 220; height += 1) {
    const transactions = [];
    if (height === 1) transactions.push(upgradeToV2, upgradeToV3);
    if (height === 102) transactions.push(transfer(1, 100, height, 1));
    if (height === 202) transactions.push(transfer(2, 200, height, 2));
    await commitHeight(source, height, transactions);
  }

  assert.equal(source.chain.protocolVersionAt(220), 3);
  assert.equal(source.chain.balance(bob), 300);
  assert.equal(source.chain.nonce(alice), 2);

  const snapshotResult = await execFileAsync(process.execPath, [
    cliPath,
    "snapshot",
    "--genesis", genesisPath,
    "--data", sourceDir,
    "--out", checkpointPath
  ], { cwd: l1Root });
  assert.match(snapshotResult.stdout, /Snapshot written at height 220/);

  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.equal(checkpoint.height, 220);
  const checkpointDigest = sha256Hex(canonicalJson(checkpoint));
  const checkpointTipHash = checkpoint.tip.hash;

  const suffix = [];
  for (let height = 221; height <= 240; height += 1) {
    const transactions = height === 221 ? [transfer(3, 300, height, 2)] : [];
    suffix.push(await commitHeight(source, height, transactions));
  }
  const expectedAt240 = source.chain.snapshot();
  assert.equal(expectedAt240.height, 240);
  assert.equal(source.chain.balance(bob), 600);
  assert.equal(source.chain.nonce(alice), 3);

  const wrongDigest = `${checkpointDigest[0] === "0" ? "1" : "0"}${checkpointDigest.slice(1)}`;
  let rejected = false;
  try {
    await execFileAsync(process.execPath, [
      cliPath,
      "checkpoint-install",
      "--genesis", genesisPath,
      "--snapshot", checkpointPath,
      "--data", rejectedDir,
      "--tip-hash", checkpointTipHash,
      "--sha256", wrongDigest
    ], { cwd: l1Root });
  } catch (error) {
    rejected = true;
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    assert.match(output, /digest mismatch/i);
  }
  assert.equal(rejected, true, "Restore accepted an incorrect external snapshot digest");
  assert.equal(await pathExists(rejectedDir), false, "Rejected restore published a target data directory");

  // From this point onward the original data directory is treated as lost. The
  // expected finalized state and suffix blocks above are the only retained
  // evidence used to validate recovery.
  const installResult = await execFileAsync(process.execPath, [
    cliPath,
    "checkpoint-install",
    "--genesis", genesisPath,
    "--snapshot", checkpointPath,
    "--data", restoredDir,
    "--tip-hash", checkpointTipHash,
    "--sha256", checkpointDigest
  ], { cwd: l1Root });
  assert.match(installResult.stdout, /Trusted checkpoint installed at height 220/);

  let restored = await ChainStore.open(genesis, restoredDir);
  assert.equal(restored.chain.height, 220);
  assert.equal(restored.chain.tip.hash, checkpointTipHash);
  assert.equal(restored.chain.protocolVersionAt(220), 3);
  assert.equal(restored.chain.balance(bob), 300);
  assert.equal(restored.chain.nonce(alice), 2);

  for (const block of suffix) {
    await restored.commitFinalizedBlock(block, block.header.timestampMs);
  }
  assertSnapshotEquivalent(restored.chain.snapshot(), expectedAt240, "suffix catch-up");

  const recoveryContinuation = transfer(4, 400, 241, 2);
  await commitHeight(restored, 241, [recoveryContinuation]);
  assert.equal(restored.chain.balance(bob), 1_000);
  assert.equal(restored.chain.nonce(alice), 4);
  const recoveredTip = restored.chain.tip.hash;
  const recoveredRoot = restored.chain.tip.header.stateRoot;

  restored = await ChainStore.open(genesis, restoredDir);
  assert.equal(restored.chain.height, 241);
  assert.equal(restored.chain.tip.hash, recoveredTip);
  assert.equal(restored.chain.tip.header.stateRoot, recoveredRoot);
  assert.equal(restored.chain.protocolVersionAt(241), 3);
  assert.equal(restored.chain.balance(bob), 1_000);
  assert.equal(restored.chain.nonce(alice), 4);

  console.log(JSON.stringify({
    status: "ok",
    checkpointHeight: 220,
    restoredHeight: 220,
    caughtUpHeight: 240,
    continuedHeight: 241,
    protocolVersion: restored.chain.protocolVersionAt(restored.chain.height),
    checkpointTipHash,
    checkpointDigest,
    finalTipHash: restored.chain.tip.hash,
    finalStateRoot: restored.chain.tip.header.stateRoot
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
