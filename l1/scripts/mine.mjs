#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ZyronChain } from "../dist/src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import {
  MINING_DIFFICULTY_BITS,
  MINING_PROTOCOL_VERSION,
  MINING_TRACKER_ADDRESS,
  meetsMiningDifficulty,
  miningRewardAtoms,
  miningWorkHash
} from "../dist/src/mining.js";
import { assertMiningNetworkIdentity, miningChallengeMatchesFinalizedTip } from "../dist/src/miner-network.js";
import { loadEncryptedMinerPrivateKey } from "../dist/src/miner-security.js";
import { createMiningClaim } from "../dist/src/transaction.js";
import { MAX_SUPPLY_ATOMS } from "../dist/src/types.js";

const MAX_RPC_RESPONSE_BYTES = 64 * 1024;
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}
assertKnownArgs();

const keyPath = requiredOption("--key");
const genesisPath = requiredOption("--genesis");
const rpc = normalizeRpcUrl(requiredOption("--rpc"));
const passwordFile = requiredOption("--password-file");
const once = args.includes("--once");
const batchSize = parsePositiveInteger(option("--batch-size") ?? "65536", "batch-size", 1_000_000);

const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8"));
const localChain = new ZyronChain(genesis);
const expectedChainId = localChain.genesis.chainId;
const expectedGenesisHash = localChain.genesisHash;
const genesisSupplyAtoms = genesisSupply(genesis);
const privateKey = await loadEncryptedMinerPrivateKey(resolve(keyPath), resolve(passwordFile));
const publicKey = publicKeyFromPrivate(privateKey);
const sender = addressFromPublicKey(publicKey);

console.log("ZyronChain permissionless miner");
console.log(`Address:      ${sender}`);
console.log(`RPC:          ${rpc}`);
console.log(`Chain:        ${expectedChainId}`);
console.log(`Genesis:      ${expectedGenesisHash}`);
console.log(`Difficulty:   ${MINING_DIFFICULTY_BITS} bits`);
console.log(`Protocol:     v${MINING_PROTOCOL_VERSION}+ required`);
console.log(`Genesis ZYN:  ${formatZyn(genesisSupplyAtoms)}`);
console.log("Mining secures issuance eligibility; validators still finalize blocks.");

let stopped = false;
process.once("SIGINT", () => { stopped = true; });
process.once("SIGTERM", () => { stopped = true; });

while (!stopped) {
  const status = await fetchAndValidateStatus();
  const protocol = await fetchJson(`${rpc}/protocol`);
  if (!Number.isSafeInteger(protocol.nextVersion) || protocol.nextVersion < MINING_PROTOCOL_VERSION) {
    console.log(`Mining is gated: next protocol is v${String(protocol.nextVersion ?? "?")}; waiting for v${MINING_PROTOCOL_VERSION}.`);
    if (once) process.exit(2);
    await sleep(10_000);
    continue;
  }

  const minerNonceResult = await fetchJson(`${rpc}/nonce/${sender}`);
  const trackerNonceResult = await fetchJson(`${rpc}/nonce/${MINING_TRACKER_ADDRESS}`);
  if (!Number.isSafeInteger(minerNonceResult.nonce) || !Number.isSafeInteger(trackerNonceResult.nonce) ||
      minerNonceResult.nonce < 0 || trackerNonceResult.nonce < 0) {
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

    // A solution is useful only for the exact finalized tip and network identity it was built on.
    const latest = await fetchAndValidateStatus();
    if (!miningChallengeMatchesFinalizedTip(latest, challenge)) {
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

  // Close the race between the last batch refresh and submission. The RPC may
  // have switched network identity or finalized a new tip while the solution
  // was found inside the batch; never sign/submit until both are revalidated.
  const beforeSubmit = await fetchAndValidateStatus();
  if (!miningChallengeMatchesFinalizedTip(beforeSubmit, challenge)) {
    console.log("Solved work became stale before submission; rebuilding challenge.");
    continue;
  }

  console.log(`Solved: ${solution.hash} after ${attempts.toLocaleString()} hashes`);
  const tx = createMiningClaim({
    chainId: challenge.chainId,
    nonce: challenge.nonce,
    sender,
    height: challenge.height,
    previousHash: challenge.previousHash,
    rewardAtoms: challenge.rewardAtoms,
    workNonce: solution.workNonce,
    timestampMs: Date.now()
  }, privateKey, publicKey);

  try {
    const result = await fetchJson(`${rpc}/tx`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tx)
    }, 10_000);
    if (result.txid !== tx.txid) throw new Error("RPC mining transaction ID mismatch");
    console.log(`Submitted mining claim ${tx.txid}`);
  } catch (error) {
    console.log(`Claim became stale or was rejected: ${error instanceof Error ? error.message : String(error)}`);
    if (once) process.exit(3);
    continue;
  }
  if (once) break;

  // Avoid repeatedly mining the same tip while this claim waits for finalization.
  while (!stopped) {
    await sleep(1_000);
    const latest = await fetchAndValidateStatus();
    if (latest.tipHash !== challenge.previousHash) break;
  }
}

console.log("Miner stopped cleanly.");

function usage() {
  console.log(`Usage:
  npm run mine -- --genesis <genesis.json> --key <wallet.json> --password-file <wallet.password> --rpc <url> [options]

Options:
  --once                Stop after one accepted claim submission
  --batch-size <n>      Hashes between finalized-tip refreshes (1-1000000; default 65536)
  --password-file <p>   Required; password file for the encrypted miner keystore
  --help, -h            Show this help

The miner accepts encrypted ZyronChain keystores only. It derives the canonical genesis hash from the supplied genesis and refuses an RPC whose chain ID or genesis hash differs. On POSIX systems the keystore and password file must be owner-only (0600 recommended). Remote RPC must use HTTPS. Plain HTTP is accepted only for loopback.`);
}

function assertKnownArgs() {
  const valued = new Set(["--key", "--genesis", "--rpc", "--password-file", "--batch-size"]);
  const flags = new Set(["--once"]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (flags.has(token)) continue;
    if (valued.has(token)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      continue;
    }
    throw new Error(`Unknown mining option: ${token}`);
  }
}

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
  if (url.pathname !== "/") throw new Error("RPC URL must be an origin without a path");
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Remote mining RPC must use HTTPS; HTTP is allowed only for loopback");
  }
  return url.toString().replace(/\/$/, "");
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

async function fetchAndValidateStatus() {
  const status = await fetchJson(`${rpc}/status`);
  assertMiningNetworkIdentity(status, expectedChainId, expectedGenesisHash);
  return status;
}

async function fetchJson(url, init = {}, timeoutMs = 8_000) {
  const headers = {
    ...(init.headers ?? {}),
    "x-zyron-rpc-version": "1"
  };
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await readBoundedBody(response);
  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new Error(`RPC returned unsupported content type: ${contentType || "missing"}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("RPC returned invalid JSON");
  }
}

async function readBoundedBody(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared)) throw new Error("RPC returned invalid Content-Length");
    if (Number(declared) > MAX_RPC_RESPONSE_BYTES) throw new Error("RPC response exceeds 64 KiB limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RPC_RESPONSE_BYTES) {
        await reader.cancel("response-too-large");
        throw new Error("RPC response exceeds 64 KiB limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function formatZyn(atoms) {
  return (atoms / 100_000_000).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
