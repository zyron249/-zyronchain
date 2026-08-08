#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "./crypto.js";
import { createRpcServer, NodeService, PeerClient, produceFinalizedBlock } from "./node.js";
import { ChainStore, SigningJournal } from "./storage.js";
import { ZyronChain } from "./chain.js";
import { createTransfer, assertAddress } from "./transaction.js";
import type { GenesisConfig } from "./types.js";
import { MAX_SUPPLY_ATOMS, type Address } from "./types.js";

const BLOCK_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "keygen") return keygen(args);
  if (command === "genesis") return createGenesis(args);
  if (command === "transfer") return submitTransfer(args);
  if (command === "node") return runNode(args);
  usage();
  process.exitCode = 2;
}

async function keygen(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--out"]));
  const output = option(args, "--out");
  if (!output) throw new Error("keygen requires --out <file>");
  const privateKey = generatePrivateKey();
  const publicKey = publicKeyFromPrivate(privateKey);
  const path = resolve(output);
  await writeFile(path, `${JSON.stringify({ privateKey, publicKey, address: addressFromPublicKey(publicKey) }, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await chmod(path, 0o600);
  console.log(`ZyronChain key written with mode 0600: ${path}`);
  console.log(`Address: ${addressFromPublicKey(publicKey)}`);
  console.log(`Public key: ${publicKey}`);
}

async function createGenesis(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set([
    "--out", "--chain-id", "--timestamp-ms", "--validator-public-key", "--oracle-public-key",
    "--activity-pool", "--allocation"
  ]));
  const output = requiredOption(args, "--out");
  const chainId = requiredOption(args, "--chain-id");
  const validators = options(args, "--validator-public-key").map((publicKey) => ({
    publicKey,
    address: addressFromPublicKey(publicKey)
  }));
  const activityOracles = options(args, "--oracle-public-key");
  const activityPool = requiredOption(args, "--activity-pool") as Address;
  const allocations = options(args, "--allocation").map(parseAllocation);
  if (!validators.length || !activityOracles.length || !allocations.length) {
    throw new Error("genesis requires validators, activity oracle(s), and allocation(s)");
  }
  const timestampText = option(args, "--timestamp-ms");
  const timestampMs = timestampText === undefined ? Date.now() : parseSafeInteger(timestampText, "timestamp-ms");
  const config: GenesisConfig = { chainId, timestampMs, validators, activityOracles, activityPool, allocations };
  // Construction is the canonical validation pass; invalid public keys, addresses, duplicates, or supply fail here.
  new ZyronChain(config);
  const path = resolve(output);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`Genesis written: ${path}`);
  console.log(`Chain ID: ${chainId}`);
}

async function runNode(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--genesis", "--data", "--host", "--port", "--peer", "--validator-key"]));
  const genesisPath = option(args, "--genesis");
  const dataDir = option(args, "--data");
  if (!genesisPath || !dataDir) throw new Error("node requires --genesis <file> --data <directory>");
  const host = option(args, "--host") ?? "127.0.0.1";
  const port = parsePort(option(args, "--port") ?? "9137");
  const peerUrls = options(args, "--peer");
  const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig;
  const store = await ChainStore.open(genesis, resolve(dataDir));
  const validatorKeyPath = option(args, "--validator-key");
  const privateKey = validatorKeyPath ? await readPrivateKey(resolve(validatorKeyPath)) : undefined;
  const journal = privateKey ? await SigningJournal.open(resolve(dataDir)) : undefined;
  if (privateKey) {
    const publicKey = publicKeyFromPrivate(privateKey);
    if (!genesis.validators.some((validator) => validator.publicKey === publicKey)) {
      throw new Error("Validator key is not present in genesis");
    }
  }
  const service = new NodeService(store, journal, privateKey);
  const peers = new PeerClient(peerUrls);

  for (const peer of peers.peers) {
    try {
      const accepted = await peers.syncFrom(peer, service);
      if (accepted) console.log(`Synced ${accepted} finalized block(s) from ${peer}`);
    } catch (error) {
      console.warn(`Peer sync skipped for ${peer}: ${safeError(error)}`);
    }
  }

  const server = createRpcServer(service);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });
  console.log(`ZyronChain ${genesis.chainId} node listening on http://${host}:${port}`);
  console.log(`Genesis ${service.status().genesisHash}, height ${service.status().height}`);

  if (privateKey) {
    setInterval(() => {
      void produceFinalizedBlock(service, peers, privateKey)
        .then((block) => { if (block) console.log(`Finalized block ${block.header.height} ${block.hash}`); })
        .catch((error) => console.warn(`Validator round failed: ${safeError(error)}`));
    }, BLOCK_INTERVAL_MS).unref();
  }
}

async function submitTransfer(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--key", "--rpc", "--chain-id", "--to", "--amount-atoms", "--fee-atoms"]));
  const key = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(key);
  const sender = addressFromPublicKey(publicKey);
  const receiver = requiredOption(args, "--to");
  assertAddress(receiver);
  const rpc = normalizeRpcUrl(requiredOption(args, "--rpc"));
  const chainId = requiredOption(args, "--chain-id");
  const amountAtoms = parseSafeInteger(requiredOption(args, "--amount-atoms"), "amount-atoms");
  const feeAtoms = parseSafeInteger(option(args, "--fee-atoms") ?? "0", "fee-atoms");
  const nonceResponse = await fetchJson(`${rpc}/nonce/${sender}`);
  if (!nonceResponse || typeof nonceResponse !== "object" || !Number.isSafeInteger((nonceResponse as { nonce?: unknown }).nonce)) {
    throw new Error("RPC returned invalid nonce");
  }
  const nonce = Number((nonceResponse as { nonce: number }).nonce) + 1;
  const tx = createTransfer(
    { chainId, nonce, sender, receiver, amountAtoms, feeAtoms, timestampMs: Date.now() },
    key,
    publicKey
  );
  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tx),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`RPC rejected transaction: HTTP ${response.status} ${await response.text()}`);
  const result = await response.json() as { txid?: unknown };
  if (result.txid !== tx.txid) throw new Error("RPC transaction ID mismatch");
  console.log(`Submitted transaction ${tx.txid}`);
}

function option(args: string[], name: string): string | undefined {
  const values = options(args, name);
  if (values.length > 1) throw new Error(`${name} may only be supplied once`);
  return values[0];
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error("Invalid port");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid port");
  return port;
}

function parseSafeInteger(value: string, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

function parseAllocation(value: string): { address: Address; amountAtoms: number } {
  const match = /^(ZYN[0-9a-f]{40}):([0-9]+)$/.exec(value);
  if (!match) throw new Error("Allocation must be ZYN<40 lowercase hex>:<atoms>");
  const amountAtoms = parseSafeInteger(match[2]!, "allocation amount");
  if (amountAtoms > MAX_SUPPLY_ATOMS) throw new Error("Allocation exceeds maximum supply");
  return { address: match[1] as Address, amountAtoms };
}

function normalizeRpcUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("RPC URL must use HTTP(S)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid RPC URL");
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 64_000) throw new Error("RPC response too large");
  return JSON.parse(text);
}

async function readPrivateKey(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (typeof parsed.privateKey !== "string" || !/^[0-9a-f]{64}$/.test(parsed.privateKey)) {
    throw new Error("Validator key file is invalid");
  }
  publicKeyFromPrivate(parsed.privateKey);
  return parsed.privateKey;
}

function assertKnownOptions(args: string[], allowed: Set<string>): void {
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name || !allowed.has(name)) throw new Error(`Unknown option: ${name ?? "<missing>"}`);
    if (args[index + 1] === undefined) throw new Error(`${name} requires a value`);
  }
}

function usage(): void {
  console.log("Usage:");
  console.log("  zyron-l1 keygen --out validator-key.json");
  console.log("  zyron-l1 genesis --out genesis.json --chain-id zyron-devnet-1 --validator-public-key <hex> --oracle-public-key <hex> --activity-pool <address> --allocation <address:atoms>");
  console.log("  zyron-l1 node --genesis genesis.json --data ./data [--validator-key validator-key.json] [--peer http://node:9137]");
  console.log("  zyron-l1 transfer --key wallet-key.json --rpc http://127.0.0.1:9137 --chain-id zyron-devnet-1 --to <address> --amount-atoms <n> [--fee-atoms <n>]");
  console.log("Validator key files contain secrets. Keep them mode 0600 and never commit them.");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "operation failed";
}

main().catch((error) => {
  console.error(`Fatal: ${safeError(error)}`);
  process.exitCode = 1;
});
