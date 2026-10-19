#!/usr/bin/env node
// Durable wallet-testnet state: planner unit checks, a DB-less /status check,
// and (when ZYRON_TESTNET_DATABASE_URL is set) a real Postgres restart.
// Start, faucet, transfer, stop, start: balances and next nonces match.
// CI sets the URL. Without it, the restart test is skipped outside CI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { createTransfer } from "../dist/src/transaction.js";
import {
  SCHEMA_SQL,
  assertWithinConfiguredSupply,
  connectWalletTestnetDatabase,
  foldIncludedTransfers,
  isTimestampOrEpochWindowError,
  planStateRestore
} from "./wallet-testnet-durable.mjs";

const ATOMS = 100_000_000;
const scriptPath = fileURLToPath(new URL("./public-testnet-rpc.mjs", import.meta.url));
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };

function keypair() {
  const privateKey = generatePrivateKey();
  const publicKey = publicKeyFromPrivate(privateKey);
  return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
}

function world() {
  const validator = keypair();
  const faucet = keypair();
  const oracle = keypair();
  const pool = keypair();
  const alice = keypair();
  const supply = 1_000 * ATOMS + 2 * ATOMS;
  const genesis = {
    chainId: "zyron-unit-testnet",
    timestampMs: Date.now() - 60_000,
    validators: [{ publicKey: validator.publicKey, address: validator.address }],
    activityOracles: [oracle.publicKey],
    activityPool: pool.address,
    allocations: [
      { address: validator.address, amountAtoms: ATOMS },
      { address: faucet.address, amountAtoms: 1_000 * ATOMS },
      { address: pool.address, amountAtoms: ATOMS }
    ]
  };
  const tx = createTransfer({
    chainId: genesis.chainId,
    nonce: 1,
    sender: faucet.address,
    receiver: alice.address,
    amountAtoms: 25 * ATOMS,
    feeAtoms: 0,
    timestampMs: 1_000
  }, faucet.privateKey, faucet.publicKey, 1);
  return { genesis, validator, faucet, alice, supply, tx };
}

await test("schema is the wallet testnet tx log plus baseline and faucet limits", () => {
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS wallet_testnet_tx/);
  assert.match(SCHEMA_SQL, /chain_id text NOT NULL/);
  assert.match(SCHEMA_SQL, /seq bigserial NOT NULL/);
  assert.match(SCHEMA_SQL, /raw_tx jsonb NOT NULL/);
  assert.match(SCHEMA_SQL, /accepted_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(SCHEMA_SQL, /wallet_testnet_baseline/);
  assert.match(SCHEMA_SQL, /wallet_testnet_faucet_limit/);
});

await test("an old transfer timestamp still replays through mempool admission", () => {
  const { genesis, validator, supply, tx } = world();
  assert.equal(tx.timestampMs, 1_000);
  const plan = planStateRestore({
    genesis,
    entries: [{ seq: 1, tx }],
    baseline: null,
    nowMs: Date.now(),
    validatorPrivateKey: validator.privateKey,
    configuredSupplyAtoms: supply
  });
  assert.equal(plan.mode, "replay");
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.genesis.allocations.length, 3);
  assert.equal(plan.restoredTxCount, 1);
});

await test("a timestamp or epoch window uses genesis allocations and does not inflate", () => {
  const { genesis, validator, faucet, alice, supply, tx } = world();
  assert.equal(isTimestampOrEpochWindowError(new Error("Activity epoch settlement window has closed")), true);
  assert.equal(isTimestampOrEpochWindowError(new Error("Transaction nonce outside mempool window")), false);
  const plan = planStateRestore({
    genesis,
    entries: [{ seq: 4, tx }],
    baseline: null,
    nowMs: Date.now(),
    validatorPrivateKey: validator.privateKey,
    configuredSupplyAtoms: supply,
    admit() { throw new Error("Activity epoch settlement window has closed"); }
  });
  assert.equal(plan.mode, "genesis");
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.baselineToSave.compactedThroughSeq, 4);
  const sum = plan.genesis.allocations.reduce((total, allocation) => total + allocation.amountAtoms, 0);
  assert.ok(sum <= supply);
  assert.equal(sum, supply);
  for (const allocation of plan.genesis.allocations) assert.equal(allocation.nonce, undefined);
  const faucetAllocation = plan.genesis.allocations.find((allocation) => allocation.address === faucet.address);
  const aliceAllocation = plan.genesis.allocations.find((allocation) => allocation.address === alice.address);
  assert.equal(faucetAllocation.amountAtoms, 975 * ATOMS);
  assert.equal(aliceAllocation.amountAtoms, 25 * ATOMS);
  assert.deepEqual(plan.recordedNonces, [{ address: faucet.address, nonce: 1 }]);
});

await test("a window error cannot fold a transfer the ledger would refuse", () => {
  const { genesis, validator, supply, faucet, alice } = world();
  const overspend = createTransfer({
    chainId: genesis.chainId,
    nonce: 1,
    sender: faucet.address,
    receiver: alice.address,
    amountAtoms: supply,
    feeAtoms: 0,
    timestampMs: 1_000
  }, faucet.privateKey, faucet.publicKey, 1);
  const plan = planStateRestore({
    genesis,
    entries: [{ seq: 1, tx: overspend }],
    baseline: null,
    nowMs: Date.now(),
    validatorPrivateKey: validator.privateKey,
    configuredSupplyAtoms: supply,
    admit() { throw new Error("Activity epoch is not closed yet"); }
  });
  assert.equal(plan.mode, "abort");
  assert.equal(plan.severe, true);
  assert.equal(plan.baselineToSave, null);
  const sum = plan.genesis.allocations.reduce((total, allocation) => total + allocation.amountAtoms, 0);
  assert.equal(sum, supply);
});

await test("a baseline above the configured test supply is not used", () => {
  const { genesis, validator, supply } = world();
  assert.throws(() => assertWithinConfiguredSupply(supply + 1, supply), /configured test genesis supply/);
  const plan = planStateRestore({
    genesis,
    entries: [],
    baseline: {
      compactedThroughSeq: 1,
      allocations: [{ address: genesis.validators[0].address, amountAtoms: supply + 1 }],
      nonces: []
    },
    nowMs: Date.now(),
    validatorPrivateKey: validator.privateKey,
    configuredSupplyAtoms: supply
  });
  assert.equal(plan.mode, "abort");
  assert.equal(plan.severe, true);
  const sum = plan.genesis.allocations.reduce((total, allocation) => total + allocation.amountAtoms, 0);
  assert.equal(sum, supply);
});

await test("folding a transfer keeps the configured supply and the next nonce", () => {
  const { genesis, faucet, alice, supply, tx } = world();
  const folded = foldIncludedTransfers(genesis, [tx]);
  assert.equal(folded.supplyAtoms, supply);
  const sender = folded.accounts.find((account) => account.address === faucet.address);
  const receiver = folded.accounts.find((account) => account.address === alice.address);
  assert.equal(sender.balanceAtoms, 975 * ATOMS);
  assert.equal(sender.nonce, 1);
  assert.equal(receiver.balanceAtoms, 25 * ATOMS);
  assert.equal(receiver.nonce, 0);
});

await test("database-less RPC reports non-durable state", async () => {
  const env = { ...process.env, PORT: "0", ZYRON_TESTNET_NODE_PORT: String(20_000 + Math.floor(Math.random() * 20_000)) };
  delete env.ZYRON_TESTNET_DATABASE_URL;
  const rpc = await startRpc(env);
  try {
    const status = await untilJson(rpc.base, "/status", (body) => body && body.valueBearing === false);
    assert.equal(status.stateDurable, false);
    assert.equal(status.restoredTxCount, 0);
    assert.equal(status.restoredAccounts, 0);
    assert.equal(status.chainId, "zyron-wallet-testnet-1");
  } finally {
    await stopRpc(rpc);
  }
});

const databaseUrl = process.env.ZYRON_TESTNET_DATABASE_URL?.trim();
if (!databaseUrl) {
  if (process.env.CI) throw new Error("ZYRON_TESTNET_DATABASE_URL is required in CI");
  console.log("skip restart simulation: ZYRON_TESTNET_DATABASE_URL is unset");
} else {
  await test("restart keeps balances, next nonce, and the faucet daily limit", async () => {
    const chainId = "zyron-durable-restart-testnet";
    const db = await connectWalletTestnetDatabase(databaseUrl);
    await db.deleteChain(chainId);
    await db.close();
    const seed = "zyron-wallet-testnet-durable-test-seed";
    const shared = {
      ZYRON_TESTNET_DATABASE_URL: databaseUrl,
      ZYRON_TESTNET_CHAIN_ID: chainId,
      ZYRON_TESTNET_SEED: seed
    };
    const first = await startRpc({ ...process.env, ...shared, PORT: "0", ZYRON_TESTNET_NODE_PORT: String(21_000 + Math.floor(Math.random() * 10_000)) });
    let snapshot;
    try {
      const status = await untilJson(first.base, "/status", (body) => body?.stateDurable === true && body.restoredTxCount === 0);
      assert.equal(status.restoredAccounts, 0);
      const alice = keypair();
      const bob = keypair();
      const drip = await postJson(first.base, "/faucet", { address: alice.address });
      assert.equal(drip.status, 200, JSON.stringify(drip.body));
      await untilJson(first.base, `/account/${alice.address}`, (body) => body?.balanceAtoms === 100 * ATOMS);
      const account = await (await fetch(`${first.base}/account/${alice.address}`)).json();
      const tx = createTransfer({
        chainId,
        nonce: account.nonce + 1,
        sender: alice.address,
        receiver: bob.address,
        amountAtoms: 25 * ATOMS,
        feeAtoms: 0,
        timestampMs: Date.now()
      }, alice.privateKey, alice.publicKey, status.transactionVersion);
      const sent = await postJson(first.base, "/tx", tx);
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const after = await untilJson(first.base, `/account/${alice.address}`, (body) => body?.balanceAtoms === 75 * ATOMS && body?.nonce === account.nonce + 1);
      const bobAccount = await untilJson(first.base, `/account/${bob.address}`, (body) => body?.balanceAtoms === 25 * ATOMS);
      snapshot = {
        alice: alice.address,
        bob: bob.address,
        aliceBalance: after.balanceAtoms,
        aliceNonce: after.nonce,
        bobBalance: bobAccount.balanceAtoms,
        bobNonce: bobAccount.nonce,
        faucet: status.faucet.address
      };
      const faucetBefore = await (await fetch(`${first.base}/account/${snapshot.faucet}`)).json();
      snapshot.faucetNonce = faucetBefore.nonce;
    } finally {
      await stopRpc(first);
    }
    const second = await startRpc({ ...process.env, ...shared, PORT: "0", ZYRON_TESTNET_NODE_PORT: String(31_000 + Math.floor(Math.random() * 10_000)) });
    try {
      const status = await untilJson(second.base, "/status", (body) => body?.stateDurable === true && body?.restoredTxCount === 2, 180_000);
      assert.ok(status.restoredAccounts >= 2);
      const alice = await (await fetch(`${second.base}/account/${snapshot.alice}`)).json();
      const bob = await (await fetch(`${second.base}/account/${snapshot.bob}`)).json();
      const faucet = await (await fetch(`${second.base}/account/${snapshot.faucet}`)).json();
      assert.equal(alice.balanceAtoms, snapshot.aliceBalance);
      assert.equal(alice.nonce, snapshot.aliceNonce);
      assert.equal(bob.balanceAtoms, snapshot.bobBalance);
      assert.equal(bob.nonce, snapshot.bobNonce);
      assert.equal(faucet.nonce, snapshot.faucetNonce);
      const again = await postJson(second.base, "/faucet", { address: snapshot.alice });
      assert.equal(again.status, 429, JSON.stringify(again.body));
    } finally {
      await stopRpc(second);
    }
  });

  await test("stored transfers are inserted once", async () => {
    const chainId = "zyron-durable-adapter-testnet";
    const db = await connectWalletTestnetDatabase(databaseUrl);
    try {
      await db.deleteChain(chainId);
      const tx = { kind: "transfer", txid: "ab".repeat(32), nonce: 1 };
      await db.insertIncluded(chainId, tx);
      await db.insertIncluded(chainId, tx);
      const loaded = await db.load(chainId);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.entries[0].tx.txid, tx.txid);
      await db.saveFaucetLimit(chainId, "address", "ZYN" + "ab".repeat(20), Date.now(), 1);
      const limits = await db.loadFaucetLimits(chainId);
      assert.equal(limits.length, 1);
      assert.equal(limits[0].hits, 1);
      await db.saveBaseline(chainId, {
        compactedThroughSeq: loaded.entries[0].seq,
        allocations: [{ address: "ZYN" + "cd".repeat(20), amountAtoms: 1 }],
        nonces: [{ address: "ZYN" + "cd".repeat(20), nonce: 2 }]
      });
      const after = await db.load(chainId);
      assert.equal(after.entries.length, 0);
      assert.equal(after.baseline.compactedThroughSeq, loaded.entries[0].seq);
      assert.equal(after.baseline.nonces[0].nonce, 2);
    } finally {
      await db.deleteChain(chainId);
      await db.close();
    }
  });
}

console.log(`wallet testnet durable tests passed: ${passed}`);

function startRpc(env) {
  const child = spawn(process.execPath, [scriptPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC did not listen\n${output.slice(-4_000)}`)), 60_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/ZyronChain wallet TESTNET RPC on 0\.0\.0\.0:(\d+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ child, base: `http://127.0.0.1:${match[1]}`, output: () => output });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      if (settled) return;
      clearTimeout(timer);
      reject(new Error(`RPC exited ${code} before listen\n${output.slice(-4_000)}`));
    });
  });
  return ready;
}

async function stopRpc(rpc) {
  if (!rpc?.child || rpc.child.exitCode !== null) return;
  const exited = new Promise((resolve) => rpc.child.once("exit", resolve));
  rpc.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  if (rpc.child.exitCode === null) rpc.child.kill("SIGKILL");
}

async function untilJson(base, path, predicate, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + path);
      const body = await response.json();
      last = `${response.status} ${JSON.stringify(body).slice(0, 300)}`;
      if (response.status === 200 && predicate(body)) return body;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${path}: ${last}`);
}

async function postJson(base, path, body) {
  const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
