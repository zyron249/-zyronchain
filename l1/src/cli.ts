#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "./crypto.js";
import {
  assertSafeRpcBinding,
  BLOCK_INTERVAL_MS,
  createRpcServer,
  NodeService,
  PeerClient,
  produceFinalizedBlock
} from "./node.js";
import { ChainStore, SigningJournal } from "./storage.js";
import { createSignedPeerRecord, loadOrCreateNodeIdentity } from "./peer-identity.js";
import { PeerReputationStore } from "./peer-reputation.js";
import { PeerDirectory } from "./peer-directory.js";
import { MIN_PROTOCOL_UPDATE_DELAY, MIN_VALIDATOR_UPDATE_DELAY, ZyronChain } from "./chain.js";
import {
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer,
  createValidatorApproval,
  createValidatorSetUpdate,
  assertAddress,
  validateTransactionShape
} from "./transaction.js";
import type { GenesisConfig, Validator, ValidatorApproval } from "./types.js";
import { MAX_SUPPLY_ATOMS, type Address } from "./types.js";

interface ValidatorProposal {
  chainId: string;
  nonce: number;
  sender: Address;
  activationHeight: number;
  validators: Validator[];
}

interface ProtocolProposal {
  chainId: string;
  nonce: number;
  sender: Address;
  activationHeight: number;
  protocolVersion: number;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "keygen") return keygen(args);
  if (command === "genesis") return createGenesis(args);
  if (command === "transfer") return submitTransfer(args);
  if (command === "validator-proposal") return createValidatorProposalFile(args);
  if (command === "validator-approve") return approveValidatorProposal(args);
  if (command === "validator-submit") return submitValidatorProposal(args);
  if (command === "protocol-proposal") return createProtocolProposalFile(args);
  if (command === "protocol-approve") return approveProtocolProposal(args);
  if (command === "protocol-submit") return submitProtocolProposal(args);
  if (command === "snapshot") return createSnapshot(args);
  if (command === "node") return runNode(args);
  usage();
  process.exitCode = 2;
}

async function createSnapshot(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--genesis", "--data", "--out"]));
  const genesisPath = requiredOption(args, "--genesis");
  const dataDir = requiredOption(args, "--data");
  const output = requiredOption(args, "--out");
  const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig;
  const store = await ChainStore.open(genesis, resolve(dataDir));
  const result = await store.writeSnapshot(resolve(output));
  console.log(`Snapshot written at height ${result.height}: ${resolve(output)}`);
  console.log(`Snapshot SHA-256: ${result.sha256}`);
  console.log("Pin and publish this digest independently before trusting the snapshot as a checkpoint.");
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
  assertKnownOptions(args, new Set([
    "--genesis", "--data", "--host", "--port", "--peer", "--advertise-peer", "--validator-key", "--peer-token-file",
    "--trusted-peer-public-key"
  ]));
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
    if (!store.chain.validatorsAt(store.chain.height + 1).some((validator) => validator.publicKey === publicKey)) {
      console.warn("Validator key is not active at the next height; it will not sign until a scheduled set activates it.");
    }
  }
  const peerTokenPath = option(args, "--peer-token-file");
  const peerAuthToken = peerTokenPath ? await readPeerAuthToken(resolve(peerTokenPath)) : undefined;
  const service = new NodeService(store, journal, privateKey);
  const advertisedPeerUrls = options(args, "--advertise-peer");
  const trustedPeerPublicKeys = options(args, "--trusted-peer-public-key");
  assertSafeRpcBinding(host, Boolean(peerAuthToken || trustedPeerPublicKeys.length));
  const issuedAtMs = Date.now();
  const identity = (peerUrls.length || advertisedPeerUrls.length || trustedPeerPublicKeys.length)
    ? await loadOrCreateNodeIdentity(resolve(dataDir))
    : undefined;
  const peerReputation = peerUrls.length ? await PeerReputationStore.open(resolve(dataDir)) : undefined;
  const peers = new PeerClient(peerUrls, peerAuthToken, identity ? {
    identity,
    chainId: service.status().chainId,
    genesisHash: service.status().genesisHash
  } : undefined, peerReputation);
  const peerRecord = identity && advertisedPeerUrls.length ? createSignedPeerRecord(identity, {
    chainId: service.status().chainId,
    genesisHash: service.status().genesisHash,
    endpoints: advertisedPeerUrls,
    issuedAtMs,
    expiresAtMs: issuedAtMs + (60 * 60 * 1_000)
  }) : undefined;
  const peerDirectory = new PeerDirectory(service.status());
  if (peerRecord) peerDirectory.admit(peerRecord, issuedAtMs);

  try {
    const accepted = await peers.syncAny(service);
    if (accepted) console.log(`Synced ${accepted} finalized block(s) from configured peers`);
  } catch (error) {
    console.warn(`Initial peer sync skipped: ${safeError(error)}`);
  }
  try {
    const discovered = await peers.refreshPeerDirectory(peerDirectory, service.status());
    if (discovered) console.log(`Discovered ${discovered} signed peer record(s) from configured peers`);
  } catch (error) {
    console.warn(`Initial peer discovery skipped: ${safeError(error)}`);
  }

  const server = createRpcServer(service, {
    ...(peerAuthToken ? { peerAuthToken } : {}),
    ...(peerRecord ? { peerRecord } : {}),
    peerDirectory,
    ...(trustedPeerPublicKeys.length ? { trustedPeerPublicKeys } : {})
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });
  console.log(`ZyronChain ${genesis.chainId} node listening on http://${host}:${port}`);
  console.log(`Genesis ${service.status().genesisHash}, height ${service.status().height}`);
  if (identity) console.log(`Node ID ${identity.nodeId}`);

  if (privateKey) {
    setInterval(() => {
      void produceFinalizedBlock(service, peers, privateKey)
        .then((block) => { if (block) console.log(`Finalized block ${block.header.height} ${block.hash}`); })
        .catch((error) => console.warn(`Validator round failed: ${safeError(error)}`));
    }, BLOCK_INTERVAL_MS).unref();
  }

  setInterval(() => {
    void (async () => {
      try {
        const accepted = await peers.syncAny(service);
        if (accepted) console.log(`Caught up ${accepted} finalized block(s) from configured peers`);
      } catch (error) {
        console.warn(`Periodic peer sync skipped: ${safeError(error)}`);
      }
    })();
  }, Math.max(5_000, Math.floor(BLOCK_INTERVAL_MS / 3))).unref();

  setInterval(() => {
    void peers.refreshPeerDirectory(peerDirectory, service.status())
      .then((discovered) => { if (discovered) console.log(`Discovered ${discovered} signed peer record(s)`); })
      .catch((error) => console.warn(`Periodic peer discovery skipped: ${safeError(error)}`));
  }, 60_000).unref();
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

async function createValidatorProposalFile(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--out", "--rpc", "--key", "--activation-height", "--validator-public-key"]));
  const output = resolve(requiredOption(args, "--out"));
  const rpc = normalizeRpcUrl(requiredOption(args, "--rpc"));
  const privateKey = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(privateKey);
  const sender = addressFromPublicKey(publicKey);
  const activationHeight = parseSafeInteger(requiredOption(args, "--activation-height"), "activation-height");
  const validatorPublicKeys = options(args, "--validator-public-key");
  if (!validatorPublicKeys.length) throw new Error("At least one --validator-public-key is required");
  const validators = validatorPublicKeys.map((key) => {
    if (!/^[0-9a-f]{128}$/.test(key)) throw new Error("Invalid validator public key");
    return { address: addressFromPublicKey(key), publicKey: key };
  });
  const status = await fetchJson(`${rpc}/status`) as { chainId?: unknown; height?: unknown };
  const nonceResult = await fetchJson(`${rpc}/nonce/${sender}`) as { nonce?: unknown };
  if (typeof status.chainId !== "string" || !Number.isSafeInteger(status.height) || !Number.isSafeInteger(nonceResult.nonce)) {
    throw new Error("RPC returned invalid proposal context");
  }
  if (activationHeight < Number(status.height) + 1 + MIN_VALIDATOR_UPDATE_DELAY) {
    throw new Error(`Activation height must be at least ${Number(status.height) + 1 + MIN_VALIDATOR_UPDATE_DELAY}`);
  }
  const proposal: ValidatorProposal = {
    chainId: status.chainId,
    nonce: Number(nonceResult.nonce) + 1,
    sender,
    activationHeight,
    validators
  };
  await writeFile(output, `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`Validator proposal written: ${output}`);
}

async function approveValidatorProposal(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--proposal", "--key", "--out"]));
  const proposal = await readValidatorProposal(resolve(requiredOption(args, "--proposal")));
  const privateKey = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(privateKey);
  const approval = createValidatorApproval(proposal, privateKey, publicKey);
  const output = resolve(requiredOption(args, "--out"));
  await writeFile(output, `${JSON.stringify(approval, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`Validator approval written: ${output}`);
}

async function submitValidatorProposal(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--proposal", "--approval", "--key", "--rpc"]));
  const proposal = await readValidatorProposal(resolve(requiredOption(args, "--proposal")));
  const privateKey = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(privateKey);
  if (addressFromPublicKey(publicKey) !== proposal.sender) throw new Error("Initiator key does not match validator proposal sender");
  const approvalPaths = options(args, "--approval");
  if (!approvalPaths.length) throw new Error("At least one --approval is required");
  const approvals: ValidatorApproval[] = [];
  for (const path of approvalPaths) approvals.push(await readValidatorApproval(resolve(path)));
  const tx = createValidatorSetUpdate(
    { ...proposal, approvals, timestampMs: Date.now() },
    privateKey,
    publicKey
  );
  validateTransactionShape(tx);
  const rpc = normalizeRpcUrl(requiredOption(args, "--rpc"));
  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tx),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`RPC rejected validator update: HTTP ${response.status} ${await response.text()}`);
  const result = await response.json() as { txid?: unknown };
  if (result.txid !== tx.txid) throw new Error("RPC validator update transaction ID mismatch");
  console.log(`Submitted validator update ${tx.txid}`);
}

async function createProtocolProposalFile(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--out", "--rpc", "--key", "--activation-height", "--protocol-version"]));
  const output = resolve(requiredOption(args, "--out"));
  const rpc = normalizeRpcUrl(requiredOption(args, "--rpc"));
  const privateKey = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(privateKey);
  const sender = addressFromPublicKey(publicKey);
  const activationHeight = parseSafeInteger(requiredOption(args, "--activation-height"), "activation-height");
  const protocolVersion = parseSafeInteger(requiredOption(args, "--protocol-version"), "protocol-version");
  if (protocolVersion < 1 || protocolVersion > 65_535) throw new Error("Protocol version must be between 1 and 65535");
  const status = await fetchJson(`${rpc}/status`) as { chainId?: unknown; height?: unknown };
  const nonceResult = await fetchJson(`${rpc}/nonce/${sender}`) as { nonce?: unknown };
  if (typeof status.chainId !== "string" || !Number.isSafeInteger(status.height) || !Number.isSafeInteger(nonceResult.nonce)) {
    throw new Error("RPC returned invalid protocol proposal context");
  }
  if (activationHeight < Number(status.height) + 1 + MIN_PROTOCOL_UPDATE_DELAY) {
    throw new Error(`Activation height must be at least ${Number(status.height) + 1 + MIN_PROTOCOL_UPDATE_DELAY}`);
  }
  const proposal: ProtocolProposal = {
    chainId: status.chainId,
    nonce: Number(nonceResult.nonce) + 1,
    sender,
    activationHeight,
    protocolVersion
  };
  await writeFile(output, `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`Protocol proposal written: ${output}`);
}

async function approveProtocolProposal(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--proposal", "--key", "--out"]));
  const proposal = await readProtocolProposal(resolve(requiredOption(args, "--proposal")));
  const privateKey = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(privateKey);
  const approval = createProtocolUpgradeApproval(proposal, privateKey, publicKey);
  const output = resolve(requiredOption(args, "--out"));
  await writeFile(output, `${JSON.stringify(approval, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`Protocol approval written: ${output}`);
}

async function submitProtocolProposal(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--proposal", "--approval", "--key", "--rpc"]));
  const proposal = await readProtocolProposal(resolve(requiredOption(args, "--proposal")));
  const privateKey = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(privateKey);
  if (addressFromPublicKey(publicKey) !== proposal.sender) throw new Error("Initiator key does not match protocol proposal sender");
  const approvalPaths = options(args, "--approval");
  if (!approvalPaths.length) throw new Error("At least one --approval is required");
  const approvals: ValidatorApproval[] = [];
  for (const path of approvalPaths) approvals.push(await readValidatorApproval(resolve(path)));
  const tx = createProtocolUpgrade(
    { ...proposal, approvals, timestampMs: Date.now() },
    privateKey,
    publicKey
  );
  validateTransactionShape(tx);
  const rpc = normalizeRpcUrl(requiredOption(args, "--rpc"));
  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tx),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`RPC rejected protocol update: HTTP ${response.status} ${await response.text()}`);
  const result = await response.json() as { txid?: unknown };
  if (result.txid !== tx.txid) throw new Error("RPC protocol update transaction ID mismatch");
  console.log(`Submitted protocol update ${tx.txid}`);
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

async function readPeerAuthToken(path: string): Promise<string> {
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) {
    throw new Error("Peer token file must contain a single 32-512 character token");
  }
  return token;
}

async function readValidatorProposal(path: string): Promise<ValidatorProposal> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assertObjectFields(value, ["chainId", "nonce", "sender", "activationHeight", "validators"], "validator proposal");
  if (typeof value.chainId !== "string" || !Number.isSafeInteger(value.nonce) || !Number.isSafeInteger(value.activationHeight) ||
      typeof value.sender !== "string" || !Array.isArray(value.validators)) throw new Error("Invalid validator proposal");
  assertAddress(value.sender);
  const validators = value.validators.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid proposal validator");
    const record = item as Record<string, unknown>;
    assertObjectFields(record, ["address", "publicKey"], "proposal validator");
    if (typeof record.address !== "string" || typeof record.publicKey !== "string" || !/^[0-9a-f]{128}$/.test(record.publicKey)) {
      throw new Error("Invalid proposal validator");
    }
    assertAddress(record.address);
    if (addressFromPublicKey(record.publicKey) !== record.address) throw new Error("Proposal validator address mismatch");
    return { address: record.address, publicKey: record.publicKey };
  });
  return {
    chainId: value.chainId,
    nonce: Number(value.nonce),
    sender: value.sender,
    activationHeight: Number(value.activationHeight),
    validators
  };
}

async function readValidatorApproval(path: string): Promise<ValidatorApproval> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assertObjectFields(value, ["validator", "publicKey", "signature"], "validator approval");
  if (typeof value.validator !== "string" || typeof value.publicKey !== "string" || typeof value.signature !== "string" ||
      !/^[0-9a-f]{128}$/.test(value.publicKey) || !/^[0-9a-f]{128}$/.test(value.signature)) {
    throw new Error("Invalid validator approval");
  }
  assertAddress(value.validator);
  if (addressFromPublicKey(value.publicKey) !== value.validator) throw new Error("Validator approval address mismatch");
  return { validator: value.validator, publicKey: value.publicKey, signature: value.signature };
}

async function readProtocolProposal(path: string): Promise<ProtocolProposal> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assertObjectFields(value, ["chainId", "nonce", "sender", "activationHeight", "protocolVersion"], "protocol proposal");
  if (typeof value.chainId !== "string" || !Number.isSafeInteger(value.nonce) || !Number.isSafeInteger(value.activationHeight) ||
      !Number.isSafeInteger(value.protocolVersion) || typeof value.sender !== "string") {
    throw new Error("Invalid protocol proposal");
  }
  assertAddress(value.sender);
  const protocolVersion = Number(value.protocolVersion);
  if (protocolVersion < 1 || protocolVersion > 65_535) throw new Error("Invalid protocol proposal version");
  return {
    chainId: value.chainId,
    nonce: Number(value.nonce),
    sender: value.sender,
    activationHeight: Number(value.activationHeight),
    protocolVersion
  };
}

function assertObjectFields(value: Record<string, unknown>, expected: string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Invalid ${name} fields`);
  }
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
  console.log("  zyron-l1 node --genesis genesis.json --data ./data [--validator-key validator-key.json] [--peer http://node:9137] [--advertise-peer https://node.example:9137] [--peer-token-file /path/to/token]");
  console.log("  zyron-l1 transfer --key wallet-key.json --rpc http://127.0.0.1:9137 --chain-id zyron-devnet-1 --to <address> --amount-atoms <n> [--fee-atoms <n>]");
  console.log("  zyron-l1 validator-proposal --out update.json --rpc <url> --key initiator.json --activation-height <n> --validator-public-key <hex> [...]");
  console.log("  zyron-l1 validator-approve --proposal update.json --key validator.json --out approval.json");
  console.log("  zyron-l1 validator-submit --proposal update.json --approval approval-a.json [...] --key initiator.json --rpc <url>");
  console.log("  zyron-l1 protocol-proposal --out upgrade.json --rpc <url> --key initiator.json --activation-height <n> --protocol-version <n>");
  console.log("  zyron-l1 protocol-approve --proposal upgrade.json --key validator.json --out approval.json");
  console.log("  zyron-l1 protocol-submit --proposal upgrade.json --approval approval-a.json [...] --key initiator.json --rpc <url>");
  console.log("  zyron-l1 snapshot --genesis genesis.json --data ./data --out checkpoint.json");
  console.log("Validator key files contain secrets. Keep them mode 0600 and never commit them.");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "operation failed";
}

main().catch((error) => {
  console.error(`Fatal: ${safeError(error)}`);
  process.exitCode = 1;
});
