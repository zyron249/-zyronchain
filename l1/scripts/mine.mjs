#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { decryptPrivateKey, isEncryptedKeystore, normalizePasswordFile } from "../dist/src/keystore.js";
import {
  MINING_DIFFICULTY_BITS,
  MINING_PROTOCOL_VERSION,
  MINING_TRACKER_ADDRESS,
  meetsMiningDifficulty,
  miningRewardAtoms,
  miningWorkHash
} from "../dist/src/mining.js";
import { createMiningClaim } from "../dist/src/transaction.js";
import { MAX_SUPPLY_ATOMS } from "../dist/src/types.js";

const args = process.argv.slice(2);
const keyPath = requiredOption("--key");
const genesisPath = requiredOption("--genesis");
const rpc = normalizeRpcUrl(requiredOption("--rpc"));
const passwordFile = option("--password-file");
const once = args.includes("--once");
const batchSize = parsePositiveInteger(option("--batch-size") ?? "65536", "batch-size", 1_000_000);

const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8"));
const genesisSupplyAtoms = genesisSupply(genesis);
const privateKey = await readPrivateKey(resolve(keyPath), passwordFile ? resolve(passwordFile) : undefined);
const publicKey = publicKeyFromPrivate(privateKey);
const sender = addressFromPublicKey(publicKey);

console.log("ZyronChain permissionless miner");
console.log(`Address:      ${sender}`);
console.log(`RPC:          ${rpc}`);
console.log(`Difficulty:   ${MINING_DIFFICULTY_BITS} bits`);
console.log(`Protocol:     v${MINING_PROTOCOL_VERSION}+ required`);
console.log(`Genesis ZYN:  ${formatZyn(genesisSupplyAtoms)}`);
console.log("Mining secures issuance eligibility; validators still finalize blocks.");

let stopped = false;
process.once("SIGINT", () => { stopped = true; });
process.once("SIGTERM", () => { stopped = true; });

while (!stopped) {
  const status = await fetchJson(`${rpc}/status`);
  const protocol = await fetchJson(`${rpc}/protocol`);
  if (typeof status.chainId !== "string" || !Number.isSafeInteger(status.height) ||
      typeof status.tipHash !== "string" || !/^[0-9a-f]{64}$/.test(status.tipHash)) {
    throw new Error("RPC returned invalid chain status");
  }
  if (!Number.isSafeInteger(protocol.nextVersion) || protocol.nextVersion < MINING_PROTOCOL_VERSION) {
    console.log(`Mining is gated: next protocol is v${String(protocol.nextVersion ?? "?")}; waiting for v${MINING_PROTOCOL_VERSION}.`);
    if (once) process.exit(2);
    await sleep(10_000);
    continue;
  }
  if (genesis.chainId !== status.chainId) throw new Error("Genesis chain ID does not match RPC chain ID");

  const minerNonceResult = await fetchJson(`${rpc}/nonce/${sender}`);
  const trackerNonceResult = await fetchJson(`${rpc}/nonce/${MINING_TRACKER_ADDRESS}`);
  if (!Number.isSafeInteger(minerNonceResult.nonce) || !Number.isSafeInteger(trackerNonceResult.nonce)) {
    throw new Error("RPC returned invalid mining nonce state");
  }
  const nonce = Number(minerNonceResult.nonce) + 1;
  const claimCount = Number(trackerNonceResult.nonce);
  const rewardAtoms = miningRewardAtoms(claimCount, genesisSupplyAtoms);
  if (rewardAtoms <= 0) {
    console.log("ZYN historical issuance cap reached. Mining has ended.");
    break;
  }

  const challenge = {
    chainId: status.chainId,
    nonce,
    sender,
    height: Number(status.height) + 1,
    previousHash: status.tipHash,
    rewardAtoms,
    workNonce: "0000000000000000",
    publicKey
  };
  console.log(`Mining height ${challenge.height} for ${formatZyn(rewardAtoms)} ZYN; finalized claims=${claimCount}`);

  const started = Date.now();
  let attempts = 0;
  let counter = 0n;
  let solution;
  while (!stopped) {
    for (let index = 0; index < batchSize; index += 1) {
      challenge.workNonce = counter.toString(16).padStart(16, "0");
      const hash = miningWorkHash(challenge);
      attempts += 1;
      counter += 1n;
      if (meetsMiningDifficulty(hash)) {
        solution = { ...challenge, hash };
        break;
      }
      if (counter > 0xffffffffffffffffn) throw new Error("Mining work nonce space exhausted");
    }
    if (solution || stopped) break;

    // A solution is useful only for the exact finalized tip it was built on.
    const latest = await fetchJson(`${rpc}/status`);
    if (latest.tipHash !== challenge.previousHash || Number(latest.height) + 1 !== challenge.height) {
      console.log("Finalized tip changed; abandoning stale work and rebuilding challenge.");
      break;
    }
    const elapsed = Math.max(1, Date.now() - started);
    const rate = Math.floor((attempts * 1000) / elapsed);
    process.stdout.write(`\r${attempts.toLocaleString()} hashes · ${rate.toLocaleString()} H/s`);
  }
  process.stdout.write("\n");
  if (stopped) break;
  if (!solution) continue;

  console.log(`Solved: ${solution.hash} after ${attempts.toLocaleString()} hashes`);
  const tx = createMiningClaim({
    chainId: challenge.chainId,
    nonce: challenge.nonce,
    sender: sender,
    height: challenge.height,
    previousHash: challenge.previousHash,
    rewardAtoms: challenge.rewardAtoms,
    workNonce: solution.workNonce,
    timestampMs: Date.now()
  }, privateKey, publicKey);

  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zyron-rpc-version": "1"
    },
    body: JSON.stringify(tx),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const text = await response.text();
    console.log(`Claim became stale or was rejected: HTTP ${response.status} ${text.slice(0, 300)}`);
    if (once) process.exit(3);
    continue;
  }
  const result = await response.json();
  if (result.txid !== tx.txid) throw new Error("RPC mining transaction ID mismatch");
  console.log(`Submitted mining claim ${tx.txid}`);
  if (once) break;

  // Avoid repeatedly mining the same tip while this claim waits for finalization.
  while (!stopped) {
    await sleep(1_000);
    const latest = await fetchJson(`${rpc}/status`);
    if (latest.tipHash !== challenge.previousHash) break;
  }
}

console.log("Miner stopped cleanly.");

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePositiveInteger(value, name, max) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${name} must be between 1 and ${max}`);
  return parsed;
}

function normalizeRpcUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("RPC URL must not contain credentials, query, or fragment");
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Remote mining RPC must use HTTPS; HTTP is allowed only for loopback");
  }
  return url.toString().replace(/\/$/, "");
}

async function readPrivateKey(path, passwordPath) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (isEncryptedKeystore(parsed)) {
    if (!passwordPath) throw new Error("Encrypted wallet requires --password-file");
    const password = normalizePasswordFile(await readFile(passwordPath, "utf8"));
    return decryptPrivateKey(parsed, password);
  }
  if (!parsed || typeof parsed.privateKey !== "string" || !/^[0-9a-f]{64}$/.test(parsed.privateKey)) {
    throw new Error("Wallet file is not a supported ZyronChain key or encrypted keystore");
  }
  return parsed.privateKey;
}

function genesisSupply(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.allocations)) throw new Error("Invalid genesis allocations");
  let total = 0;
  for (const allocation of value.allocations) {
    if (!allocation || !Number.isSafeInteger(allocation.amountAtoms) || allocation.amountAtoms < 0) {
      throw new Error("Invalid genesis allocation amount");
    }
    total += allocation.amountAtoms;
    if (!Number.isSafeInteger(total) || total > MAX_SUPPLY_ATOMS) throw new Error("Genesis supply exceeds 50M ZYN cap");
  }
  return total;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "x-zyron-rpc-version": "1" },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`RPC request failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

function formatZyn(atoms) {
  return (atoms / 100_000_000).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
