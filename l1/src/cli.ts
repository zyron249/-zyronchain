#!/usr/bin/env node
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Multiaddr } from "@multiformats/multiaddr";

import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "./crypto.js";
import { decryptPrivateKey, encryptPrivateKey, isEncryptedKeystore, normalizePasswordFile } from "./keystore.js";
import {
  assertSafeRpcBinding,
  BLOCK_INTERVAL_MS,
  createRpcServer,
  NodeService,
  PeerClient,
  produceFinalizedBlock,
  RPC_API_VERSION,
  type ConsensusPeerClient
} from "./node.js";
import { ChainStore, NodeDataDirectoryLease, SigningJournal } from "./storage.js";
import { createSignedPeerRecord, loadOrCreateNodeIdentity } from "./peer-identity.js";
import { PeerReputationStore } from "./peer-reputation.js";
import { PeerDirectory } from "./peer-directory.js";
import { createP2PNode, registerP2PIdentityProtocol } from "./p2p.js";
import { registerP2PSyncProtocol, syncP2PFrom } from "./p2p-sync.js";
import { fetchTrustedSnapshotFromPeer, registerP2PCheckpointProtocol } from "./p2p-checkpoint.js";
import { fetchTrustedPortableStateFromAnyPeer, MAX_STATE_SYNC_PEERS, registerP2PStateProtocol } from "./p2p-state.js";
import { NativeConsensusPeerClient, registerP2PConsensusProtocol } from "./p2p-consensus.js";
import { BackgroundTaskTracker, drainHttpServer } from "./node-lifecycle.js";
import { discoverNativePeersFrom, registerP2PDiscoveryProtocol } from "./p2p-discovery.js";
import { assertSafeDiscoveredPeer, NativePeerPool } from "./p2p-peer-pool.js";
import { classifyNativePeerFailure, NativePeerReputationStore } from "./p2p-reputation.js";
import {
  diversityOrderedNativePeers,
  nativePeerId,
  parseNativeListenAddress,
  parseNativePeerAddress,
  parseNativePeerGroup
} from "./p2p-address.js";
import { MIN_PROTOCOL_UPDATE_DELAY, MIN_VALIDATOR_UPDATE_DELAY, ZyronChain } from "./chain.js";
import {
  createProtocolUpgrade,
  createProtocolUpgradeApproval,
  createTransfer,
  createValidatorApproval,
  createValidatorSetUpdate,
  assertAddress,
  validateTransactionShape,
  type TransactionVersion
} from "./transaction.js";
import type { GenesisConfig, Validator, ValidatorApproval } from "./types.js";
import { MAX_SUPPLY_ATOMS, type Address } from "./types.js";
import { LocalValidatorSigner, RemoteValidatorSigner, type ValidatorSigner } from "./validator-signer.js";

interface ValidatorProposal {
  transactionVersion: TransactionVersion;
  chainId: string;
  nonce: number;
  sender: Address;
  activationHeight: number;
  validators: Validator[];
}

interface ProtocolProposal {
  transactionVersion: TransactionVersion;
  chainId: string;
  nonce: number;
  sender: Address;
  activationHeight: number;
  protocolVersion: number;
}

const MAX_NATIVE_SYNC_PROBES_PER_CYCLE = 4;
const MAX_NATIVE_DISCOVERY_SOURCES_PER_CYCLE = 4;
const MAX_NATIVE_DISCOVERY_CANDIDATES_PER_SOURCE = 4;
const NATIVE_DYNAMIC_EVICT_TRANSIENT_FAILURES = 3;

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
  if (command === "checkpoint-install") return installCheckpoint(args);
  if (command === "checkpoint-fetch-install") return fetchAndInstallCheckpoint(args);
  if (command === "state-fetch-install") return fetchAndInstallPortableState(args);
  if (command === "prune-finalized") return pruneFinalized(args);
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
  const resolvedDataDir = resolve(dataDir);
  const lease = await NodeDataDirectoryLease.acquire(resolvedDataDir);
  try {
    const store = await ChainStore.open(genesis, resolvedDataDir);
    const result = await store.writeSnapshot(resolve(output));
    console.log(`Snapshot written at height ${result.height}: ${resolve(output)}`);
    console.log(`Snapshot SHA-256: ${result.sha256}`);
    console.log("Pin and publish this digest independently before trusting the snapshot as a checkpoint.");
  } finally {
    lease.close();
  }
}

async function installCheckpoint(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--genesis", "--snapshot", "--data", "--tip-hash", "--sha256"]));
  const genesisPath = requiredOption(args, "--genesis");
  const snapshotPath = requiredOption(args, "--snapshot");
  const dataDir = resolve(requiredOption(args, "--data"));
  const tipHash = requiredOption(args, "--tip-hash");
  const snapshotSha256 = requiredOption(args, "--sha256");
  if (!/^[0-9a-f]{64}$/.test(tipHash) || !/^[0-9a-f]{64}$/.test(snapshotSha256)) {
    throw new Error("checkpoint-install requires lowercase 32-byte --tip-hash and --sha256 anchors");
  }
  const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig;
  const snapshot = JSON.parse(await readFile(resolve(snapshotPath), "utf8")) as unknown;
  const store = await ChainStore.installTrustedSnapshot(genesis, dataDir, snapshot, { tipHash, snapshotSha256 });
  console.log(`Trusted checkpoint installed at height ${store.chain.height}: ${dataDir}`);
  console.log(`Finalized tip: ${store.chain.tip.hash}`);
  console.log(`Snapshot SHA-256: ${snapshotSha256}`);
}

async function fetchAndInstallCheckpoint(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--genesis", "--p2p-peer", "--data", "--tip-hash", "--sha256"]));
  const genesisPath = requiredOption(args, "--genesis");
  const peer = parseNativePeerAddress(requiredOption(args, "--p2p-peer"));
  const dataDir = resolve(requiredOption(args, "--data"));
  const tipHash = requiredOption(args, "--tip-hash");
  const snapshotSha256 = requiredOption(args, "--sha256");
  if (!/^[0-9a-f]{64}$/.test(tipHash) || !/^[0-9a-f]{64}$/.test(snapshotSha256)) {
    throw new Error("checkpoint-fetch-install requires lowercase 32-byte --tip-hash and --sha256 anchors");
  }
  const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig;
  // The fetch identity is deliberately ephemeral and separate from the target.
  // No target data exists until the complete snapshot passes external-anchor,
  // finality, governance and State-v2 validation.
  const temporaryIdentityDir = await mkdtemp(join(tmpdir(), "zyron-checkpoint-fetch-"));
  let client: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const identity = await loadOrCreateNodeIdentity(temporaryIdentityDir);
    client = await createP2PNode(identity);
    const anchor = { tipHash, snapshotSha256 };
    const snapshot = await fetchTrustedSnapshotFromPeer(client, peer, identity, genesis, anchor);
    await client.stop();
    client = undefined;
    const store = await ChainStore.installTrustedSnapshot(genesis, dataDir, snapshot, anchor);
    console.log(`Trusted checkpoint fetched and installed at height ${store.chain.height}: ${dataDir}`);
    console.log(`Finalized tip: ${store.chain.tip.hash}`);
    console.log(`Snapshot SHA-256: ${snapshotSha256}`);
  } finally {
    if (client) {
      try { await client.stop(); } catch { /* best-effort cleanup after the primary failure */ }
    }
    await rm(temporaryIdentityDir, { recursive: true, force: true });
  }
}

async function fetchAndInstallPortableState(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--genesis", "--p2p-peer", "--data", "--tip-hash", "--sha256"]));
  const genesisPath = requiredOption(args, "--genesis");
  const peerValues = options(args, "--p2p-peer");
  if (peerValues.length < 1 || peerValues.length > MAX_STATE_SYNC_PEERS) {
    throw new Error(`state-fetch-install requires 1-${MAX_STATE_SYNC_PEERS} --p2p-peer values`);
  }
  const peers = peerValues.map(parseNativePeerAddress);
  if (new Set(peers.map(nativePeerId)).size !== peers.length) throw new Error("state-fetch-install peer IDs must be unique");
  const dataDir = resolve(requiredOption(args, "--data"));
  const tipHash = requiredOption(args, "--tip-hash");
  const snapshotSha256 = requiredOption(args, "--sha256");
  if (!/^[0-9a-f]{64}$/.test(tipHash) || !/^[0-9a-f]{64}$/.test(snapshotSha256)) {
    throw new Error("state-fetch-install requires lowercase 32-byte --tip-hash and --sha256 anchors");
  }
  const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig;
  const resumeDir = `${dataDir}.state-sync-${tipHash.slice(0, 16)}-${snapshotSha256.slice(0, 16)}`;
  const temporaryIdentityDir = await mkdtemp(join(tmpdir(), "zyron-state-fetch-"));
  let client: Awaited<ReturnType<typeof createP2PNode>> | undefined;
  try {
    const identity = await loadOrCreateNodeIdentity(temporaryIdentityDir);
    client = await createP2PNode(identity);
    const anchor = { tipHash, snapshotSha256 };
    const fetched = await fetchTrustedPortableStateFromAnyPeer(client, peers, identity, genesis, anchor, resumeDir);
    await client.stop();
    client = undefined;
    const store = await ChainStore.installTrustedPortableState(genesis, dataDir, fetched.tip, fetched.bundle, anchor);
    await rm(resumeDir, { recursive: true, force: true });
    console.log(`Trusted portable State-v2 fetched and installed at height ${store.chain.height}: ${dataDir}`);
    console.log(`Finalized tip: ${store.chain.tip.hash}`);
    console.log(`Snapshot SHA-256: ${snapshotSha256}`);
  } finally {
    if (client) {
      try { await client.stop(); } catch { /* best-effort cleanup after the primary failure */ }
    }
    await rm(temporaryIdentityDir, { recursive: true, force: true });
  }
}

async function pruneFinalized(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--genesis", "--data", "--retain-blocks"]));
  const genesisPath = requiredOption(args, "--genesis");
  const dataDir = resolve(requiredOption(args, "--data"));
  const retainBlocks = parseSafeInteger(requiredOption(args, "--retain-blocks"), "retain-blocks");
  if (retainBlocks < 1) throw new Error("prune-finalized requires --retain-blocks >= 1");
  const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig;
  const lease = await NodeDataDirectoryLease.acquire(dataDir);
  try {
    const store = await ChainStore.open(genesis, dataDir);
    const result = await store.pruneFinalizedHistory({}, retainBlocks);
    console.log(`Finalized history pruned through height ${result.prunedThroughHeight}`);
    console.log(`First retained finalized block: ${result.firstStoredHeight}`);
    console.log(`Latest ${retainBlocks} finalized block(s) remain available for block sync.`);
  } finally {
    lease.close();
  }
}

async function keygen(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--out", "--password-file"]));
  const output = option(args, "--out");
  if (!output) throw new Error("keygen requires --out <file>");
  const passwordFile = option(args, "--password-file");
  const password = passwordFile
    ? normalizePasswordFile(await readFile(resolve(passwordFile), "utf8"))
    : undefined;
  const privateKey = generatePrivateKey();
  const publicKey = publicKeyFromPrivate(privateKey);
  const address = addressFromPublicKey(publicKey);
  const stored = password
    ? encryptPrivateKey(privateKey, password)
    : { privateKey, publicKey, address };
  const path = resolve(output);
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await chmod(path, 0o600);
  console.log(`ZyronChain ${password ? "encrypted " : ""}key written with mode 0600: ${path}`);
  console.log(`Address: ${address}`);
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
    "--trusted-peer-public-key", "--rpc-trusted-proxy", "--p2p-listen", "--p2p-peer", "--p2p-peer-group", "--validator-signer-url",
    "--validator-public-key", "--validator-signer-token-file"
  ]));
  const genesisPath = option(args, "--genesis");
  const dataDir = option(args, "--data");
  if (!genesisPath || !dataDir) throw new Error("node requires --genesis <file> --data <directory>");
  const resolvedDataDir = resolve(dataDir);
  const dataLease = await NodeDataDirectoryLease.acquire(resolvedDataDir);
  const host = option(args, "--host") ?? "127.0.0.1";
  const port = parsePort(option(args, "--port") ?? "9137");
  const trustedProxyAddresses = options(args, "--rpc-trusted-proxy");
  const peerUrls = options(args, "--peer");
  const nativeListen = options(args, "--p2p-listen").map(parseNativeListenAddress);
  const nativePeers = options(args, "--p2p-peer").map(parseNativePeerAddress);
  if (nativePeers.length > 64) throw new Error("Too many configured native peers");
  const nativePeerGroups = new Map<string, string>();
  const configuredNativePeerIds = new Set(nativePeers.map(nativePeerId));
  for (const value of options(args, "--p2p-peer-group")) {
    const assignment = parseNativePeerGroup(value);
    if (!configuredNativePeerIds.has(assignment.peerId)) throw new Error("Native peer group references an unconfigured PeerId");
    const existing = nativePeerGroups.get(assignment.peerId);
    if (existing !== undefined && existing !== assignment.group) throw new Error("Conflicting native peer group assignment");
    nativePeerGroups.set(assignment.peerId, assignment.group);
  }
  const genesis = JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig;
  const store = await ChainStore.open(genesis, resolvedDataDir);
  const validatorKeyPath = option(args, "--validator-key");
  const privateKey = validatorKeyPath ? await readPrivateKey(resolve(validatorKeyPath)) : undefined;
  const validatorSignerUrl = option(args, "--validator-signer-url");
  const validatorPublicKey = option(args, "--validator-public-key");
  const validatorSignerTokenPath = option(args, "--validator-signer-token-file");
  if (validatorKeyPath && (validatorSignerUrl || validatorPublicKey || validatorSignerTokenPath)) {
    throw new Error("--validator-key cannot be combined with remote validator signer options");
  }
  if (Boolean(validatorSignerUrl) !== Boolean(validatorPublicKey)) {
    throw new Error("Remote validator signing requires both --validator-signer-url and --validator-public-key");
  }
  if (validatorSignerUrl && !validatorSignerTokenPath) {
    throw new Error("Remote validator signing requires --validator-signer-token-file");
  }
  if (validatorSignerTokenPath && !validatorSignerUrl) {
    throw new Error("--validator-signer-token-file requires --validator-signer-url");
  }
  const validatorSignerToken = validatorSignerTokenPath
    ? await readAuthToken(resolve(validatorSignerTokenPath), "Validator signer", true)
    : undefined;
  const validatorSigner: ValidatorSigner | undefined = privateKey
    ? new LocalValidatorSigner(privateKey)
    : validatorSignerUrl && validatorPublicKey && validatorSignerToken
      ? new RemoteValidatorSigner(validatorSignerUrl, validatorPublicKey, validatorSignerToken)
      : undefined;
  const journal = validatorSigner ? await SigningJournal.open(resolvedDataDir) : undefined;
  if (validatorSigner) {
    const publicKey = validatorSigner.publicKey;
    if (!store.chain.validatorsAt(store.chain.height + 1).some((validator) => validator.publicKey === publicKey)) {
      console.warn("Validator key is not active at the next height; it will not sign until a scheduled set activates it.");
    }
  }
  const peerTokenPath = option(args, "--peer-token-file");
  const peerAuthToken = peerTokenPath ? await readAuthToken(resolve(peerTokenPath), "Peer") : undefined;
  const service = new NodeService(store, journal, validatorSigner);
  const advertisedPeerUrls = options(args, "--advertise-peer");
  const trustedPeerPublicKeys = options(args, "--trusted-peer-public-key");
  assertSafeRpcBinding(
    host,
    Boolean(peerAuthToken || trustedPeerPublicKeys.length),
    trustedProxyAddresses.length > 0
  );
  const issuedAtMs = Date.now();
  const identity = (peerUrls.length || advertisedPeerUrls.length || trustedPeerPublicKeys.length || nativeListen.length || nativePeers.length)
    ? await loadOrCreateNodeIdentity(resolve(dataDir))
    : undefined;
  const peerReputation = peerUrls.length ? await PeerReputationStore.open(resolve(dataDir)) : undefined;
  const nativePeerReputation = nativePeers.length ? await NativePeerReputationStore.open(resolve(dataDir)) : undefined;
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
  const nativeNode = identity && (nativeListen.length || nativePeers.length)
    ? await createP2PNode(identity, { listen: nativeListen })
    : undefined;
  const nativePeerPool = nativeNode
    ? new NativePeerPool(nativePeers, nativeNode.peerId.toString(), nativePeerGroups)
    : undefined;
  let nativeConsensus: NativeConsensusPeerClient | undefined;
  if (nativeNode && identity && nativePeerPool) {
    await registerP2PIdentityProtocol(nativeNode, identity, service.status());
    await registerP2PSyncProtocol(nativeNode, identity, service);
    await registerP2PCheckpointProtocol(nativeNode, identity, service);
    await registerP2PStateProtocol(nativeNode, identity, service);
    await registerP2PConsensusProtocol(nativeNode, identity, service);
    await registerP2PDiscoveryProtocol(nativeNode, identity, service.status(), () =>
      nativePeerPool.snapshot().filter((peer) => {
        try { assertSafeDiscoveredPeer(peer); return true; } catch { return false; }
      })
    );
    nativeConsensus = new NativeConsensusPeerClient(
      nativeNode,
      nativePeerPool.snapshot(),
      identity,
      service.status()
    );
  }

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
  let nativeSyncCursor = 0;
  if (nativeNode && identity && nativePeerPool) {
    const admitted = await refreshNativePeerDiscovery(
      nativeNode, nativePeerPool, identity, service.status(), nativeSyncCursor, nativePeerReputation
    );
    if (admitted && nativeConsensus) nativeConsensus.replaceTargets(nativePeerPool.snapshot(nativeSyncCursor));
    await syncNativePeers(nativeNode, nativePeerPool.snapshot(), identity, service, "Initial native peer sync", nativeSyncCursor++, nativePeerGroups, nativePeerReputation, nativePeerPool);
    nativeConsensus?.replaceTargets(nativePeerPool.snapshot(nativeSyncCursor));
  }

  const consensusPeers: ConsensusPeerClient = nativeConsensus ? {
    requestAttestations: async (block) => [
      ...await peers.requestAttestations(block),
      ...await nativeConsensus.requestAttestations(block)
    ],
    requestRoundSkips: async (height, round, previousCertificate = []) => [
      ...await peers.requestRoundSkips(height, round, previousCertificate),
      ...await nativeConsensus.requestRoundSkips(height, round, previousCertificate)
    ],
    broadcastBlock: async (block) => {
      await Promise.allSettled([peers.broadcastBlock(block), nativeConsensus.broadcastBlock(block)]);
    }
  } : peers;

  const server = createRpcServer(service, {
    ...(peerAuthToken ? { peerAuthToken } : {}),
    ...(peerRecord ? { peerRecord } : {}),
    peerDirectory,
    ...(trustedPeerPublicKeys.length ? { trustedPeerPublicKeys } : {}),
    ...(trustedProxyAddresses.length ? { trustedProxyAddresses } : {}),
    onTransactionAccepted: async (transaction) => {
      await Promise.allSettled([
        peers.broadcastTransaction(transaction),
        ...(nativeConsensus ? [nativeConsensus.broadcastTransaction(transaction)] : [])
      ]);
    }
  });
  // Retain the OS-backed writer lease for exactly the server lifetime.
  server.once("close", () => dataLease.close());
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });
  const timers = new Set<NodeJS.Timeout>();
  const backgroundTasks = new BackgroundTaskTracker();
  const schedule = (callback: () => void, delayMs: number): void => {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    timers.add(timer);
  };
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; draining node services`);
    backgroundTasks.stopAccepting();
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    const rpcDrain = await drainHttpServer(server);
    if (rpcDrain === "forced") {
      console.warn("RPC drain deadline exceeded; remaining connections were closed");
    }
    await backgroundTasks.drain();
    if (nativeNode) await nativeNode.stop();
    dataLease.close();
    console.log("ZyronChain node shutdown complete");
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).catch((error) => {
      console.error(`Graceful shutdown failed: ${safeError(error)}`);
      process.exitCode = 1;
      server.closeAllConnections();
      dataLease.close();
    });
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  console.log(`ZyronChain ${genesis.chainId} node listening on http://${host}:${port}`);
  if (trustedProxyAddresses.length) console.log("RPC accepts requests only from configured proxies asserting x-forwarded-proto: https");
  console.log(`Genesis ${service.status().genesisHash}, height ${service.status().height}`);
  if (identity) console.log(`Node ID ${identity.nodeId}`);
  if (nativeNode) {
    for (const address of nativeNode.getMultiaddrs()) console.log(`Native P2P ${address.toString()}`);
  }

  if (validatorSigner) {
    schedule(() => {
      backgroundTasks.run(() => produceFinalizedBlock(service, consensusPeers, validatorSigner)
        .then((block) => { if (block) console.log(`Finalized block ${block.header.height} ${block.hash}`); })
        .catch((error) => console.warn(`Validator round failed: ${safeError(error)}`)));
    }, BLOCK_INTERVAL_MS);
  }

  schedule(() => {
    backgroundTasks.run(async () => {
      try {
        const accepted = await peers.syncAny(service);
        if (accepted) console.log(`Caught up ${accepted} finalized block(s) from configured peers`);
      } catch (error) {
        console.warn(`Periodic peer sync skipped: ${safeError(error)}`);
      }
    });
  }, Math.max(5_000, Math.floor(BLOCK_INTERVAL_MS / 3)));

  if (nativeNode && identity && nativePeerPool && nativePeerPool.size) {
    let nativeSyncRunning = false;
    schedule(() => {
      if (nativeSyncRunning) return;
      nativeSyncRunning = true;
      backgroundTasks.run(() => syncNativePeers(nativeNode, nativePeerPool.snapshot(), identity, service, "Periodic native peer sync", nativeSyncCursor++, nativePeerGroups, nativePeerReputation, nativePeerPool)
        .then(() => nativeConsensus?.replaceTargets(nativePeerPool.snapshot(nativeSyncCursor)))
        .finally(() => { nativeSyncRunning = false; }));
    }, Math.max(5_000, Math.floor(BLOCK_INTERVAL_MS / 3)));
  }

  if (nativeNode && identity && nativePeerPool && nativePeerPool.size) {
    let nativeDiscoveryRunning = false;
    schedule(() => {
      if (nativeDiscoveryRunning) return;
      nativeDiscoveryRunning = true;
      backgroundTasks.run(() => refreshNativePeerDiscovery(nativeNode, nativePeerPool, identity, service.status(), nativeSyncCursor, nativePeerReputation)
        .then((admitted) => {
          if (!admitted) return;
          nativeConsensus?.replaceTargets(nativePeerPool.snapshot(nativeSyncCursor));
          console.log(`Native peer discovery admitted ${admitted} authenticated peer(s)`);
        })
        .catch((error) => console.warn(`Periodic native peer discovery skipped: ${safeError(error)}`))
        .finally(() => { nativeDiscoveryRunning = false; }));
    }, 60_000);
  }

  schedule(() => {
    backgroundTasks.run(() => peers.refreshPeerDirectory(peerDirectory, service.status())
      .then((discovered) => { if (discovered) console.log(`Discovered ${discovered} signed peer record(s)`); })
      .catch((error) => console.warn(`Periodic peer discovery skipped: ${safeError(error)}`)));
  }, 60_000);
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
  const transactionVersion = await transactionVersionForRpc(rpc);
  const tx = createTransfer(
    { chainId, nonce, sender, receiver, amountAtoms, feeAtoms, timestampMs: Date.now() },
    key,
    publicKey,
    transactionVersion
  );
  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zyron-rpc-version": String(RPC_API_VERSION) },
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
  const transactionVersion = await transactionVersionForRpc(rpc);
  if (typeof status.chainId !== "string" || !Number.isSafeInteger(status.height) || !Number.isSafeInteger(nonceResult.nonce)) {
    throw new Error("RPC returned invalid proposal context");
  }
  if (activationHeight < Number(status.height) + 1 + MIN_VALIDATOR_UPDATE_DELAY) {
    throw new Error(`Activation height must be at least ${Number(status.height) + 1 + MIN_VALIDATOR_UPDATE_DELAY}`);
  }
  const proposal: ValidatorProposal = {
    transactionVersion,
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
  const approval = createValidatorApproval(proposal, privateKey, publicKey, proposal.transactionVersion);
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
    publicKey,
    proposal.transactionVersion
  );
  validateTransactionShape(tx);
  const rpc = normalizeRpcUrl(requiredOption(args, "--rpc"));
  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zyron-rpc-version": String(RPC_API_VERSION) },
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
  const transactionVersion = await transactionVersionForRpc(rpc);
  if (typeof status.chainId !== "string" || !Number.isSafeInteger(status.height) || !Number.isSafeInteger(nonceResult.nonce)) {
    throw new Error("RPC returned invalid protocol proposal context");
  }
  if (activationHeight < Number(status.height) + 1 + MIN_PROTOCOL_UPDATE_DELAY) {
    throw new Error(`Activation height must be at least ${Number(status.height) + 1 + MIN_PROTOCOL_UPDATE_DELAY}`);
  }
  const proposal: ProtocolProposal = {
    transactionVersion,
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
  const approval = createProtocolUpgradeApproval(proposal, privateKey, publicKey, proposal.transactionVersion);
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
    publicKey,
    proposal.transactionVersion
  );
  validateTransactionShape(tx);
  const rpc = normalizeRpcUrl(requiredOption(args, "--rpc"));
  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zyron-rpc-version": String(RPC_API_VERSION) },
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

async function syncNativePeers(
  node: Awaited<ReturnType<typeof createP2PNode>>,
  peers: readonly Multiaddr[],
  identity: Awaited<ReturnType<typeof loadOrCreateNodeIdentity>>,
  service: NodeService,
  label: string,
  groupOffset = 0,
  peerGroups: ReadonlyMap<string, string> = new Map(),
  reputation?: NativePeerReputationStore,
  pool?: NativePeerPool
): Promise<void> {
  for (const peer of diversityOrderedNativePeers(peers, groupOffset, peerGroups).slice(0, MAX_NATIVE_SYNC_PROBES_PER_CYCLE)) {
    const peerId = nativePeerId(peer);
    if (reputation && !reputation.isAvailable(peerId)) continue;
    try {
      const accepted = await syncP2PFrom(node, peer, identity, service);
      await reputation?.recordSuccess(peerId);
      if (accepted) console.log(`${label}: accepted ${accepted} finalized block(s) from ${peer.toString()}`);
    } catch (error) {
      const failure = classifyNativePeerFailure(error);
      await reputation?.recordFailure(peerId, failure);
      if (pool?.isDynamic(peerId) && (failure === "protocol" || (reputation?.failureCount(peerId) ?? 0) >= NATIVE_DYNAMIC_EVICT_TRANSIENT_FAILURES)) {
        pool.evictDynamic(peerId);
      }
      console.warn(`${label} skipped ${peer.toString()}: ${safeError(error)}`);
    }
  }
}

async function refreshNativePeerDiscovery(
  node: Awaited<ReturnType<typeof createP2PNode>>,
  pool: NativePeerPool,
  identity: Awaited<ReturnType<typeof loadOrCreateNodeIdentity>>,
  chain: { chainId: string; genesisHash: string },
  groupOffset = 0,
  reputation?: NativePeerReputationStore
): Promise<number> {
  let admitted = 0;
  for (const source of pool.snapshot(groupOffset).slice(0, MAX_NATIVE_DISCOVERY_SOURCES_PER_CYCLE)) {
    const sourcePeerId = nativePeerId(source);
    if (reputation && !reputation.isAvailable(sourcePeerId)) continue;
    let candidates: Multiaddr[];
    try {
      candidates = await discoverNativePeersFrom(node, source, identity, chain);
    } catch (error) {
      const failure = classifyNativePeerFailure(error);
      // A transient discovery-stream problem must not suppress an otherwise
      // healthy configured peer from the independent finalized-sync path.
      if (failure === "protocol") {
        await reputation?.recordFailure(sourcePeerId, failure);
        pool.evictDynamic(sourcePeerId);
      }
      console.warn(`Native peer discovery skipped ${source.toString()}: ${safeError(error)}`);
      continue;
    }
    const selected = diversityOrderedNativePeers(candidates, groupOffset).slice(0, MAX_NATIVE_DISCOVERY_CANDIDATES_PER_SOURCE);
    let unsafeHint = false;
    for (const candidate of selected) {
      const candidatePeerId = nativePeerId(candidate);
      if (pool.has(candidatePeerId) || (reputation && !reputation.isAvailable(candidatePeerId))) continue;
      try {
        // An authenticated source that advertises an unsafe auto-dial address
        // is itself violating discovery policy; do not attribute that hint to
        // the uninvolved candidate identity.
        assertSafeDiscoveredPeer(candidate);
      } catch (error) {
        await reputation?.recordFailure(sourcePeerId, "protocol");
        pool.evictDynamic(sourcePeerId);
        console.warn(`Native peer discovery rejected unsafe hint from ${source.toString()}: ${safeError(error)}`);
        unsafeHint = true;
        break;
      }
    }
    if (unsafeHint) continue;
    const verification = await Promise.allSettled(selected.map(async (candidate) => {
      const candidatePeerId = nativePeerId(candidate);
      if (pool.has(candidatePeerId) || (reputation && !reputation.isAvailable(candidatePeerId))) return false;
      return pool.verifyAndAdmit(node, identity, chain, candidate, sourcePeerId);
    }));
    for (let index = 0; index < verification.length; index += 1) {
      const result = verification[index]!;
      if (result.status === "fulfilled") {
        if (result.value) admitted += 1;
        continue;
      }
      const candidate = selected[index]!;
      await reputation?.recordFailure(nativePeerId(candidate), classifyNativePeerFailure(result.reason));
      console.warn(`Native peer discovery failed candidate ${candidate.toString()}: ${safeError(result.reason)}`);
    }
  }
  return admitted;
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
  const response = await fetch(url, {
    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },
    signal: AbortSignal.timeout(8_000)
  });
  assertCompatibleRpcResponse(response);
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 64_000) throw new Error("RPC response too large");
  return JSON.parse(text);
}

async function transactionVersionForRpc(rpc: string): Promise<TransactionVersion> {
  const response = await fetch(`${rpc}/protocol`, {
    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },
    signal: AbortSignal.timeout(8_000)
  });
  assertCompatibleRpcResponse(response);
  if (response.status === 404) return 1;
  if (!response.ok) throw new Error(`RPC protocol status returned HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 4_096) throw new Error("RPC protocol status response too large");
  const value = JSON.parse(text) as Record<string, unknown>;
  assertObjectFields(value, ["currentVersion", "nextVersion"], "protocol status");
  if (!Number.isSafeInteger(value.currentVersion) || !Number.isSafeInteger(value.nextVersion)) {
    throw new Error("RPC returned invalid protocol status");
  }
  const nextVersion = Number(value.nextVersion);
  if (nextVersion < 1 || nextVersion > 3) throw new Error("RPC returned unsupported next protocol version");
  return nextVersion >= 3 ? 2 : 1;
}

function assertCompatibleRpcResponse(response: Response): void {
  const advertised = response.headers.get("x-zyron-rpc-version");
  if (advertised !== null && advertised !== String(RPC_API_VERSION)) {
    throw new Error(`RPC server uses unsupported API version ${advertised}`);
  }
}

async function readPrivateKey(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (isEncryptedKeystore(parsed)) {
    const passwordPath = process.env.ZYRON_KEYSTORE_PASSWORD_FILE;
    if (!passwordPath) {
      throw new Error("Encrypted keystore requires ZYRON_KEYSTORE_PASSWORD_FILE");
    }
    const password = normalizePasswordFile(await readFile(resolve(passwordPath), "utf8"));
    return decryptPrivateKey(parsed, password);
  }
  if (typeof parsed.privateKey !== "string" || !/^[0-9a-f]{64}$/.test(parsed.privateKey)) {
    throw new Error("Validator key file is invalid");
  }
  publicKeyFromPrivate(parsed.privateKey);
  return parsed.privateKey;
}

async function readAuthToken(path: string, label: string, requirePrivatePermissions = false): Promise<string> {
  if (requirePrivatePermissions) {
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error(`${label} token file must be a regular file with mode 0600`);
    }
  }
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`${label} token file must contain a single 32-512 character token`);
  }
  return token;
}

async function readValidatorProposal(path: string): Promise<ValidatorProposal> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const hasTransactionVersion = Object.hasOwn(value, "transactionVersion");
  assertObjectFields(value, hasTransactionVersion
    ? ["transactionVersion", "chainId", "nonce", "sender", "activationHeight", "validators"]
    : ["chainId", "nonce", "sender", "activationHeight", "validators"], "validator proposal");
  const transactionVersion = hasTransactionVersion ? Number(value.transactionVersion) : 1;
  if ((transactionVersion !== 1 && transactionVersion !== 2) || typeof value.chainId !== "string" ||
      !Number.isSafeInteger(value.nonce) || !Number.isSafeInteger(value.activationHeight) ||
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
    transactionVersion,
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
  const hasTransactionVersion = Object.hasOwn(value, "transactionVersion");
  assertObjectFields(value, hasTransactionVersion
    ? ["transactionVersion", "chainId", "nonce", "sender", "activationHeight", "protocolVersion"]
    : ["chainId", "nonce", "sender", "activationHeight", "protocolVersion"], "protocol proposal");
  const transactionVersion = hasTransactionVersion ? Number(value.transactionVersion) : 1;
  if ((transactionVersion !== 1 && transactionVersion !== 2) || typeof value.chainId !== "string" ||
      !Number.isSafeInteger(value.nonce) || !Number.isSafeInteger(value.activationHeight) ||
      !Number.isSafeInteger(value.protocolVersion) || typeof value.sender !== "string") {
    throw new Error("Invalid protocol proposal");
  }
  assertAddress(value.sender);
  const protocolVersion = Number(value.protocolVersion);
  if (protocolVersion < 1 || protocolVersion > 65_535) throw new Error("Invalid protocol proposal version");
  return {
    transactionVersion,
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
  console.log("  zyron-l1 keygen --out validator-key.json [--password-file password.txt]");
  console.log("  zyron-l1 genesis --out genesis.json --chain-id zyron-devnet-1 --validator-public-key <hex> --oracle-public-key <hex> --activity-pool <address> --allocation <address:atoms>");
  console.log("  zyron-l1 node --genesis genesis.json --data ./data [--validator-key validator-key.json | --validator-signer-url https://signer/sign --validator-public-key <hex> --validator-signer-token-file signer-token.txt] [--peer https://node:9137] [--rpc-trusted-proxy <ip> ...] [--p2p-listen /ip4/0.0.0.0/tcp/9140] [--p2p-peer /dns4/node.example/tcp/9140/p2p/<PeerId>] [--p2p-peer-group <PeerId>=<failure-domain>]");
  console.log("  zyron-l1 transfer --key wallet-key.json --rpc http://127.0.0.1:9137 --chain-id zyron-devnet-1 --to <address> --amount-atoms <n> [--fee-atoms <n>]");
  console.log("  zyron-l1 validator-proposal --out update.json --rpc <url> --key initiator.json --activation-height <n> --validator-public-key <hex> [...]");
  console.log("  zyron-l1 validator-approve --proposal update.json --key validator.json --out approval.json");
  console.log("  zyron-l1 validator-submit --proposal update.json --approval approval-a.json [...] --key initiator.json --rpc <url>");
  console.log("  zyron-l1 protocol-proposal --out upgrade.json --rpc <url> --key initiator.json --activation-height <n> --protocol-version <n>");
  console.log("  zyron-l1 protocol-approve --proposal upgrade.json --key validator.json --out approval.json");
  console.log("  zyron-l1 protocol-submit --proposal upgrade.json --approval approval-a.json [...] --key initiator.json --rpc <url>");
  console.log("  zyron-l1 snapshot --genesis genesis.json --data ./data --out checkpoint.json");
  console.log("  zyron-l1 checkpoint-install --genesis genesis.json --snapshot checkpoint.json --data ./NEW-data --tip-hash <trusted-hex> --sha256 <trusted-hex>");
  console.log("  zyron-l1 checkpoint-fetch-install --genesis genesis.json --p2p-peer /ip4/203.0.113.10/tcp/9140/p2p/<PeerId> --data ./NEW-data --tip-hash <trusted-hex> --sha256 <trusted-hex>");
  console.log("  zyron-l1 state-fetch-install --genesis genesis.json --p2p-peer /ip4/203.0.113.10/tcp/9140/p2p/<PeerId> [--p2p-peer <independent-pinned-peer> ...] --data ./NEW-data --tip-hash <trusted-hex> --sha256 <trusted-hex>");
  console.log("  zyron-l1 prune-finalized --genesis genesis.json --data ./data --retain-blocks <n>=1");
  console.log("Checkpoint install anchors must come from an independent trusted channel, never from the snapshot peer.");
  console.log("Validator key files contain secrets. Keep them mode 0600 and never commit them.");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "operation failed";
}

main().catch((error) => {
  console.error(`Fatal: ${safeError(error)}`);
  process.exitCode = 1;
});
