#!/usr/bin/env node
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Multiaddr } from "@multiformats/multiaddr";

import { V6_MIN_ACTIVATION_MARGIN_BLOCKS, isConsensusV6 } from "./consensus-v6.js";
import { V6LeaderScheduler } from "./v6-scheduler.js";
import { addressFromPublicKey, assertValidPublicKey, generatePrivateKey, publicKeyFromPrivate } from "./crypto.js";
import { decryptPrivateKey, encryptPrivateKey, isEncryptedKeystore, keystoreVersion, migrateKeystore, normalizePasswordFile } from "./keystore.js";
import { parseAddressInput, toChecksumAddress } from "./address-checksum.js";
import { displayAddress, groupAddress, lookalikeMatches, parseKnownAddresses, sendWarnings, type KnownAddresses } from "./send-warnings.js";
import { assertPasswordStrength, promptHiddenLine } from "./password-prompt.js";
import { readPrivateRegularFile } from "./local-security.js";
import { readCliCheckpointSnapshotAnchoredUtf8, readCliGenesisUtf8 } from "./cli-recovery-file.js";
import { readCliGovernanceArtifactUtf8 } from "./cli-governance-file.js";
import { readOperatorAuthToken, readOperatorPrivateKey } from "./operator-secrets.js";
import {
  assertRpcRateLimitExemptConfiguration,
  assertSafeRpcBinding,
  BLOCK_INTERVAL_MS,
  createRpcServer,
  NodeService,
  PeerClient,
  produceFinalizedBlock,
  RPC_API_VERSION,
  type ConsensusPeerClient
} from "./node.js";
import { MEMPOOL_MIN_FEE_ENV, parseMempoolMinFeeAtoms } from "./mempool.js";
import { ChainStore, NodeDataDirectoryLease, SigningJournal } from "./storage.js";
import { createSignedPeerRecord, loadOrCreateNodeIdentity } from "./peer-identity.js";
import { PeerReputationStore } from "./peer-reputation.js";
import { PeerDirectory } from "./peer-directory.js";
import { createP2PNode, registerP2PIdentityProtocol } from "./p2p.js";
import { registerP2PSyncProtocol, syncP2PFrom } from "./p2p-sync.js";
import { fetchTrustedSnapshotFromPeer, registerP2PCheckpointProtocol } from "./p2p-checkpoint.js";
import { fetchTrustedPortableStateFromAnyPeer, MAX_STATE_SYNC_PEERS, registerP2PStateProtocol } from "./p2p-state.js";
import { NativeConsensusPeerClient, parseNativeConsensusPeerAllowlist, registerP2PConsensusProtocol } from "./p2p-consensus.js";
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
  createValidatorApproval,
  createValidatorSetUpdate,
  assertAddress,
  signTransfer,
  validateTransactionShape,
  type TransactionVersion
} from "./transaction.js";
import { IntentRenderRefusal, renderIntent, TRANSFER_INTENT_DOMAIN, type RenderedIntent, type TransferPayload } from "./intent-render.js";
import { offlineProtocolForChain, resolveTransferVersion } from "./transfer-version-policy.js";
import type { Block, GenesisConfig, Validator, ValidatorApproval, ValidatorPossessionProof } from "./types.js";
import {
  POSSESSION_PROOF_POLICY_V1,
  genesisPossessionChainBinding,
  signPossessionProof,
  verifyPossessionProof
} from "./validator-admission.js";
import { MAX_SUPPLY_ATOMS, type Address } from "./types.js";
import { LocalValidatorSigner, RemoteValidatorSigner, type ValidatorSigner } from "./validator-signer.js";
import {
  assertRpcApiVersion,
  readBoundedJson,
  readBoundedResponseText,
  transactionVersionForProtocolVersion
} from "./rpc-client.js";

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
  if (command === "keystore-verify") return verifyKeystore(args);
  if (command === "keystore-migrate") return migrateKeystoreFile(args);
  if (command === "address-checksum") return showAddressChecksum(args);
  if (command === "send-check") return sendCheck(args);
  if (command === "transfer-sign") return signTransferOffline(args);
  if (command === "tx-submit") return submitSignedTransaction(args);
  if (command === "validator-proposal") return createValidatorProposalFile(args);
  if (command === "validator-approve") return approveValidatorProposal(args);
  if (command === "validator-submit") return submitValidatorProposal(args);
  if (command === "validator-possession-proof") return createValidatorPossessionProofFile(args);
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
  const genesis = JSON.parse(await readCliGenesisUtf8(resolve(genesisPath))) as GenesisConfig;
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
  const genesis = JSON.parse(await readCliGenesisUtf8(resolve(genesisPath))) as GenesisConfig;
  const snapshot = JSON.parse(await readCliCheckpointSnapshotAnchoredUtf8(resolve(snapshotPath), snapshotSha256)) as unknown;
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
  const genesis = JSON.parse(await readCliGenesisUtf8(resolve(genesisPath))) as GenesisConfig;
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
      try { await client.stop(); } catch { }
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
  const genesis = JSON.parse(await readCliGenesisUtf8(resolve(genesisPath))) as GenesisConfig;
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
      try { await client.stop(); } catch { }
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
  const genesis = JSON.parse(await readCliGenesisUtf8(resolve(genesisPath))) as GenesisConfig;
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

async function keygen(rawArgs: string[]): Promise<void> {
  // --password-prompt is a bare flag; every other keygen option takes a value.
  const prompt = rawArgs.includes("--password-prompt");
  const args = rawArgs.filter((value) => value !== "--password-prompt");
  assertKnownOptions(args, new Set(["--out", "--password-file"]));
  const output = option(args, "--out");
  if (!output) throw new Error("keygen requires --out <file>");
  const passwordFile = option(args, "--password-file");
  if (prompt && passwordFile) throw new Error("Use either --password-file or --password-prompt, not both");
  let password: string | undefined;
  if (passwordFile) {
    password = normalizePasswordFile(await readPrivateRegularFile(resolve(passwordFile), "Keygen password file"));
  } else if (prompt) {
    // Interactive: nothing is written to disk. Ask twice and enforce the strength check.
    const first = await promptHiddenLine("Choose wallet password (12+ chars, a long passphrase is best): ");
    assertPasswordStrength(first);
    const second = await promptHiddenLine("Type the same password again: ");
    if (first !== second) throw new Error("Passwords do not match. Nothing was created.");
    password = normalizePasswordFile(first);
  }
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
  console.log(`Address (checksummed display): ${toChecksumAddress(address)}`);
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
    "--validator-public-key", "--validator-signer-token-file", "--validator-signer-allow-v6", "--ready-max-tip-age-ms", "--mempool-max-future-per-sender", "--mempool-parked-ttl-ms",
    "--mempool-min-fee-atoms",
    "--p2p-consensus-peer", "--rpc-rate-limit-exempt", "--rpc-submit-per-minute"
  ]));
  const genesisPath = option(args, "--genesis");
  const dataDir = option(args, "--data");
  if (!genesisPath || !dataDir) throw new Error("node requires --genesis <file> --data <directory>");
  const resolvedDataDir = resolve(dataDir);
  const dataLease = await NodeDataDirectoryLease.acquire(resolvedDataDir);
  const host = option(args, "--host") ?? "127.0.0.1";
  const port = parsePort(option(args, "--port") ?? "9137");
  const trustedProxyAddresses = options(args, "--rpc-trusted-proxy");
  // P1-02-M3: loopback addresses of a co-located gateway that enforces its own
  // per-client limits; P1-02-L2: optional per-client POST /tx window.
  const rateLimitExemptAddresses = options(args, "--rpc-rate-limit-exempt");
  assertRpcRateLimitExemptConfiguration(rateLimitExemptAddresses, trustedProxyAddresses);
  const submitPerMinuteText = option(args, "--rpc-submit-per-minute");
  const submitRequestsPerWindow = submitPerMinuteText === undefined
    ? undefined
    : parseSafeInteger(submitPerMinuteText, "rpc-submit-per-minute");
  if (submitRequestsPerWindow !== undefined && submitRequestsPerWindow < 1) {
    throw new Error("--rpc-submit-per-minute must be at least 1");
  }
  const peerUrls = options(args, "--peer");
  const nativeListen = options(args, "--p2p-listen").map(parseNativeListenAddress);
  const nativePeers = options(args, "--p2p-peer").map(parseNativePeerAddress);
  if (nativePeers.length > 64) throw new Error("Too many configured native peers");
  // F-12: optional allowlist of PeerIds that may deliver native consensus messages.
  const consensusPeerAllowlist = parseNativeConsensusPeerAllowlist(options(args, "--p2p-consensus-peer"));
  if (consensusPeerAllowlist && nativeListen.length === 0 && nativePeers.length === 0) {
    throw new Error("--p2p-consensus-peer requires native P2P (--p2p-listen or --p2p-peer)");
  }
  const nativePeerGroups = new Map<string, string>();
  const configuredNativePeerIds = new Set(nativePeers.map(nativePeerId));
  for (const value of options(args, "--p2p-peer-group")) {
    const assignment = parseNativePeerGroup(value);
    if (!configuredNativePeerIds.has(assignment.peerId)) throw new Error("Native peer group references an unconfigured PeerId");
    const existing = nativePeerGroups.get(assignment.peerId);
    if (existing !== undefined && existing !== assignment.group) throw new Error("Conflicting native peer group assignment");
    nativePeerGroups.set(assignment.peerId, assignment.group);
  }
  const genesis = JSON.parse(await readCliGenesisUtf8(resolve(genesisPath))) as GenesisConfig;
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
    ? await readAuthToken(resolve(validatorSignerTokenPath), "Validator signer")
    : undefined;
  // Protocol v6 intents are refused by a remote signer unless explicitly
  // enabled (F-01 §16.9-7): the signer does not enforce the §6 journal rules
  // itself, so only the node's journal protects against conflicting votes.
  const signerAllowV6 = option(args, "--validator-signer-allow-v6");
  if (signerAllowV6 !== undefined && signerAllowV6 !== "true" && signerAllowV6 !== "false") {
    throw new Error("--validator-signer-allow-v6 must be true or false");
  }
  if (signerAllowV6 !== undefined && !validatorSignerUrl) {
    throw new Error("--validator-signer-allow-v6 requires --validator-signer-url");
  }
  const validatorSigner: ValidatorSigner | undefined = privateKey
    ? new LocalValidatorSigner(privateKey)
    : validatorSignerUrl && validatorPublicKey && validatorSignerToken
      ? new RemoteValidatorSigner(validatorSignerUrl, validatorPublicKey, validatorSignerToken, undefined, {
        allowConsensusV6Intents: signerAllowV6 === "true"
      })
      : undefined;
  const journal = validatorSigner ? await SigningJournal.open(resolvedDataDir) : undefined;
  if (validatorSigner) {
    const publicKey = validatorSigner.publicKey;
    if (!store.chain.validatorsAt(store.chain.height + 1).some((validator) => validator.publicKey === publicKey)) {
      console.warn("Validator key is not active at the next height; it will not sign until a scheduled set activates it.");
    }
  }
  {
    const nextHeight = store.chain.height + 1;
    const validatorCount = store.chain.validatorsAt(nextHeight).length;
    if (isConsensusV6(store.chain.protocolVersionAt(nextHeight)) && validatorCount < 4) {
      // F-01 §16.9: v6 with n < 4 tolerates no faulty validator (f = 0).
      console.warn(`Protocol v6 consensus with ${validatorCount} validator(s) tolerates no faulty or offline validator; use at least 4.`);
    }
  }
  const peerTokenPath = option(args, "--peer-token-file");
  const peerAuthToken = peerTokenPath ? await readAuthToken(resolve(peerTokenPath), "Peer") : undefined;
  const readyMaxTipAgeText = option(args, "--ready-max-tip-age-ms");
  const minFeeFlag = option(args, "--mempool-min-fee-atoms");
  // The flag wins over the env var; either one fails closed on a bad value.
  const mempoolMinTransferFeeAtoms = minFeeFlag !== undefined
    ? parseMempoolMinFeeAtoms(minFeeFlag === "" ? "invalid" : minFeeFlag)
    : parseMempoolMinFeeAtoms(process.env[MEMPOOL_MIN_FEE_ENV], MEMPOOL_MIN_FEE_ENV);
  // Red Team S1 MEDIUM 1: mempool policy for nonce-gap ("parked") transactions.
  const futureCapText = option(args, "--mempool-max-future-per-sender") ?? process.env.ZYRON_MEMPOOL_MAX_FUTURE_PER_SENDER;
  const parkedTtlText = option(args, "--mempool-parked-ttl-ms") ?? process.env.ZYRON_MEMPOOL_PARKED_TTL_MS;
  const service = new NodeService(store, journal, validatorSigner, {
    readinessMaxTipAgeMs: readyMaxTipAgeText === undefined ? undefined : parseSafeInteger(readyMaxTipAgeText, "ready-max-tip-age-ms"),
    mempoolMinTransferFeeAtoms,
    mempoolMaxFutureNoncePerSender: futureCapText === undefined || futureCapText === ""
      ? undefined : parseSafeInteger(futureCapText, "mempool-max-future-per-sender"),
    mempoolParkedTxTtlMs: parkedTtlText === undefined || parkedTtlText === ""
      ? undefined : parseSafeInteger(parkedTtlText, "mempool-parked-ttl-ms")
  });
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
    await registerP2PConsensusProtocol(nativeNode, identity, service, { consensusPeerAllowlist });
    if (validatorSigner && nativeListen.length && !consensusPeerAllowlist) {
      console.warn("Native consensus accepts messages from any peer; set --p2p-consensus-peer <PeerId> for each validator peer to restrict it");
    }
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
    },
    // Protocol v6 (F-01): votes from both transports are merged; the leader
    // de-duplicates and verifies every vote before counting it.
    requestV6Prepare: async (request) => [
      ...await peers.requestV6Prepare(request),
      ...await nativeConsensus.requestV6Prepare(request)
    ],
    requestV6Commit: async (request) => [
      ...await peers.requestV6Commit(request),
      ...await nativeConsensus.requestV6Commit(request)
    ],
    requestV6Timeouts: async (height, round) => [
      ...await peers.requestV6Timeouts(height, round),
      ...await nativeConsensus.requestV6Timeouts(height, round)
    ],
    fetchV6Block: async (height, blockHash) =>
      await peers.fetchV6Block(height, blockHash) ?? await nativeConsensus.fetchV6Block(height, blockHash)
  } : peers;

  const server = createRpcServer(service, {
    ...(peerAuthToken ? { peerAuthToken } : {}),
    ...(peerRecord ? { peerRecord } : {}),
    peerDirectory,
    ...(trustedPeerPublicKeys.length ? { trustedPeerPublicKeys } : {}),
    ...(trustedProxyAddresses.length ? { trustedProxyAddresses } : {}),
    ...(rateLimitExemptAddresses.length ? { rateLimitExemptAddresses } : {}),
    ...(submitRequestsPerWindow !== undefined ? { submitRequestsPerWindow } : {}),
    onTransactionAccepted: async (transaction) => {
      await Promise.allSettled([
        peers.broadcastTransaction(transaction),
        ...(nativeConsensus ? [nativeConsensus.broadcastTransaction(transaction)] : [])
      ]);
    }
  });
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
  let v6Stop: () => void = () => {};
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; draining node services`);
    backgroundTasks.stopAccepting();
    v6Stop();
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
    const nextIsV6 = (): boolean => isConsensusV6(service.store.chain.protocolVersionAt(service.store.chain.height + 1));
    // Legacy heights (v1/v2/v3/v5): unchanged fixed tick.
    schedule(() => {
      if (nextIsV6()) return;
      backgroundTasks.run(() => produceFinalizedBlock(service, consensusPeers, validatorSigner)
        .then((block) => { if (block) console.log(`Finalized block ${block.header.height} ${block.hash}`); })
        .catch((error) => console.warn(`Validator round failed: ${safeError(error)}`)));
    }, BLOCK_INTERVAL_MS);
    // Protocol v6 heights: event-driven leader scheduling (F-01 §3.3/§8.6),
    // idle (3 s fallback poll) while the next height is legacy.
    const v6Scheduler = new V6LeaderScheduler<Block>({
      context: () => {
        if (!nextIsV6()) return null;
        const chain = service.store.chain;
        const height = chain.height + 1;
        return { tipTimestampMs: chain.tip.header.timestampMs, height, validators: chain.validatorsAt(height), publicKey: validatorSigner.publicKey };
      },
      attempt: async () => {
        // Tracked so that shutdown drains an in-flight attempt.
        let task: Promise<Block | null> | undefined;
        if (!backgroundTasks.run(() => (task = produceFinalizedBlock(service, consensusPeers, validatorSigner)))) return null;
        return task ?? null;
      },
      onResult: (block) => console.log(`Finalized block ${block.header.height} ${block.hash} (v6 round ${String(block.commitRound)})`),
      onError: (error) => console.warn(`Validator v6 round failed: ${safeError(error)}`)
    });
    v6Scheduler.start();
    v6Stop = () => v6Scheduler.stop();
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

async function submitTransfer(rawArgs: string[]): Promise<void> {
  const { args, yes } = takeYesFlag(rawArgs);
  assertKnownOptions(args, new Set(["--key", "--rpc", "--chain-id", "--to", "--amount-atoms", "--fee-atoms", "--expect-receiver", "--expect-amount"]));
  const key = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(key);
  const sender = addressFromPublicKey(publicKey);
  const receiver = parseAddressInput(requiredOption(args, "--to")).canonical;
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
  // Option 3: the version comes from the node's advertised protocol, never from a flag.
  // Protocol < 3 is refused (the CLI never signs version 1; see issue #1147).
  const version = resolveTransferVersion(chainId, await advertisedProtocolForRpc(rpc), "node");
  const rendered = await renderAndConfirmTransfer(args, yes, {
    kind: "transfer", version, chainId, nonce, sender, receiver, amountAtoms, feeAtoms, timestampMs: Date.now(), publicKey
  });
  const tx = signTransfer(rendered, key);
  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zyron-rpc-version": String(RPC_API_VERSION) },
    body: JSON.stringify(tx),
    signal: AbortSignal.timeout(8_000)
  });
  assertRpcApiVersion(response, RPC_API_VERSION);
  if (!response.ok) {
    throw new Error(`RPC rejected transaction: HTTP ${response.status} ${await readBoundedResponseText(response, 4_096, "RPC transaction error")}`);
  }
  const result = await readBoundedJson(response, 4_096, "RPC transaction response") as { txid?: unknown };
  if (result.txid !== tx.txid) throw new Error("RPC transaction ID mismatch");
  console.log(`Submitted transaction ${tx.txid}`);
}

/**
 * Decrypts a keystore locally (password via ZYRON_KEYSTORE_PASSWORD_FILE) and proves it
 * re-derives the stored identity. Prints only public data; never prints the private key.
 */
async function verifyKeystore(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--key"]));
  const path = resolve(requiredOption(args, "--key"));
  const key = await readPrivateKey(path);
  const publicKey = publicKeyFromPrivate(key);
  const address = addressFromPublicKey(publicKey);
  const parsed = JSON.parse(await readPrivateRegularFile(path, "Keystore")) as unknown;
  console.log("Keystore verified: it decrypts and re-derives its public key and address.");
  if (isEncryptedKeystore(parsed)) {
    const version = keystoreVersion(parsed);
    console.log(`Keystore format: v${version}${version === 1 ? " (legacy scrypt N=2^15; run keystore-migrate to upgrade to v2, N=2^17)" : " (scrypt N=2^17, r=8, p=1)"}`);
  }
  console.log(`Address: ${address}`);
  console.log(`Address (checksummed display): ${toChecksumAddress(address)}`);
  console.log(`Public key: ${publicKey}`);
}

/** Re-encrypts a v1 or v2 keystore into v2 (fresh salt/IV). Never overwrites; source is kept. */
async function migrateKeystoreFile(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--key", "--out"]));
  const source = resolve(requiredOption(args, "--key"));
  const output = resolve(requiredOption(args, "--out"));
  if (source === output) throw new Error("--out must be a new file; the original keystore is kept as a backup");
  const parsed = JSON.parse(await readPrivateRegularFile(source, "Keystore")) as unknown;
  if (!isEncryptedKeystore(parsed)) throw new Error("keystore-migrate only accepts encrypted keystores");
  const password = await keystorePassword();
  const from = keystoreVersion(parsed);
  const migrated = migrateKeystore(parsed, password);
  // Prove the new file decrypts to the same identity before writing it.
  decryptPrivateKey(migrated, password);
  if (migrated.address !== (parsed as { address: string }).address) throw new Error("Migrated keystore identity mismatch");
  await writeFile(output, `${JSON.stringify(migrated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(output, 0o600);
  console.log(`Keystore migrated v${from} -> v2 (scrypt N=2^17, r=8, p=1): ${output}`);
  console.log(`Address unchanged: ${migrated.address}`);
  console.log("Verify the new file with keystore-verify, back it up, then retire the old copy.");
}

async function showAddressChecksum(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--address"]));
  const parsed = parseAddressInput(requiredOption(args, "--address"));
  console.log(`Canonical (consensus) address: ${parsed.canonical}`);
  console.log(`Checksummed display address:   ${parsed.checksummed}`);
  console.log(parsed.checksumVerified
    ? "Checksum: verified (mixed-case input matched)."
    : "Checksum: none in input (plain lower-case form is valid; compare it carefully).");
}

/**
 * Advisory, offline send-safety check (feature 7). Reads an optional local known-address file
 * ({contacts, sent, thresholdAtoms}, same shape as the PWA book) and prints warnings. No network,
 * no keys; it never changes what a node accepts. Exits non-zero only for the blocking self-send case.
 */
async function sendCheck(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--to", "--from", "--amount-atoms", "--known-file", "--format"]));
  const receiver = parseAddressInput(requiredOption(args, "--to")).canonical;
  const fromText = option(args, "--from");
  const from = fromText === undefined ? null : parseAddressInput(fromText).canonical;
  const amountText = option(args, "--amount-atoms");
  const amountAtoms = amountText === undefined ? undefined : parseSafeInteger(amountText, "amount-atoms");
  const format = option(args, "--format") ?? "text";
  if (format !== "text" && format !== "json") throw new Error("--format must be text or json");
  const knownPath = option(args, "--known-file");
  let known: KnownAddresses = { contacts: [], sent: [], thresholdAtoms: null };
  if (knownPath !== undefined) {
    const text = await readFile(resolve(knownPath), "utf8");
    if (Buffer.byteLength(text, "utf8") > 65_536) throw new Error("Known-address file is too large");
    known = parseKnownAddresses(JSON.parse(text) as unknown);
  }
  const warnings = sendWarnings(amountAtoms === undefined ? { receiver } : { receiver, amountAtoms }, from ? { address: from } : null, known);
  const blocking = warnings.find((warning) => warning.blocking);
  if (format === "json") {
    console.log(JSON.stringify({ receiver, display: displayAddress(receiver), advisory: true, warnings }, null, 2));
  } else {
    console.log(`Receiver (checksummed, grouped): ${displayAddress(receiver)}`);
    const look = lookalikeMatches(receiver, known);
    if (look.truncated) {
      const total = new Set([...known.contacts.map((c) => c.address), ...known.sent]).size;
      console.log(`note: only the first ${look.compared} of ${total} known addresses were compared for lookalikes`);
    }
    if (warnings.length === 0) console.log("No send warnings. Still compare every character of the address.");
    for (const warning of warnings) {
      console.log(`WARNING (${warning.code}${warning.blocking ? ", blocking" : ""}): ${warning.message}`);
      if (warning.code === "lookalike") {
        for (const match of warning.matches) {
          const label = match.source === "contact" ? `contact "${match.name}"` : "sent history";
          console.log(`  known (${label}): ${groupAddress(toChecksumAddress(match.address))}`);
          console.log(`  differs at hex positions: ${match.diff.join(", ")}`);
        }
      }
    }
  }
  if (blocking) throw new Error(blocking.message);
}

/**
 * Offline transfer signing: no network access. The caller supplies the chain ID and the next
 * account nonce; the transaction version comes from OFFLINE_CHAIN_PROTOCOLS (transfer-version-policy.ts),
 * and an optional --tx-version may only confirm it. The signed transfer
 * can be carried to an online machine and broadcast later with `tx-submit`.
 */
async function signTransferOffline(rawArgs: string[]): Promise<void> {
  const { args, yes } = takeYesFlag(rawArgs);
  assertKnownOptions(args, new Set([
    "--key", "--chain-id", "--to", "--amount-atoms", "--fee-atoms", "--nonce", "--tx-version", "--timestamp-ms", "--out",
    "--expect-receiver", "--expect-amount"
  ]));
  const output = resolve(requiredOption(args, "--out"));
  const chainId = requiredOption(args, "--chain-id");
  if (!/^[a-z0-9-]{3,64}$/.test(chainId)) throw new Error("Invalid chain-id (expected the genesis chain ID, e.g. zyron-devnet-1)");
  const receiver = parseAddressInput(requiredOption(args, "--to")).canonical;
  assertAddress(receiver);
  const amountAtoms = parseSafeInteger(requiredOption(args, "--amount-atoms"), "amount-atoms");
  const feeAtoms = parseSafeInteger(option(args, "--fee-atoms") ?? "0", "fee-atoms");
  const nonce = parseSafeInteger(requiredOption(args, "--nonce"), "nonce");
  if (nonce < 1) throw new Error("nonce must be the next account nonce (current nonce + 1, starting at 1)");
  const versionText = option(args, "--tx-version");
  if (versionText !== undefined && versionText !== "1" && versionText !== "2") {
    throw new Error("tx-version must be 2 (it only confirms the version of the chain's advertised protocol; version 1 is never signed)");
  }
  // Option 3: the version comes from the fixed offline protocol table (unknown chain: v2-capable);
  // --tx-version may only confirm it.
  const version = resolveTransferVersion(
    chainId, offlineProtocolForChain(chainId), "offline-table", versionText === undefined ? undefined : Number(versionText)
  );
  const timestampMs = parseSafeInteger(option(args, "--timestamp-ms") ?? String(Date.now()), "timestamp-ms");
  const key = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(key);
  const sender = addressFromPublicKey(publicKey);
  if (receiver === sender) throw new Error("Receiver must differ from the sender");
  const rendered = await renderAndConfirmTransfer(args, yes, {
    kind: "transfer", version, chainId, nonce, sender, receiver, amountAtoms, feeAtoms, timestampMs, publicKey
  });
  const tx = signTransfer(rendered, key);
  validateTransactionShape(tx);
  await writeFile(output, `${JSON.stringify(tx, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`Signed transfer written (public data, no secrets): ${output}`);
  console.log(`Transaction ID: ${tx.txid}`);
  console.log(`From ${sender} to ${receiver}: ${amountAtoms} atoms, fee ${feeAtoms} atoms, nonce ${nonce}, chain ${chainId}`);
}

/**
 * Removes the bare `--yes` flag (feature 6A, resolved question 5). It is only ever read from the
 * command line: no environment variable or config file can enable it.
 */
function takeYesFlag(rawArgs: string[]): { args: string[]; yes: boolean } {
  const count = rawArgs.filter((arg) => arg === "--yes").length;
  if (count > 1) throw new Error("--yes may only be supplied once");
  return { args: rawArgs.filter((arg) => arg !== "--yes"), yes: count === 1 };
}

/**
 * Feature 6A: renders the transfer with the shared fail-closed renderer, prints the full render to
 * stderr (always, including with --yes), applies the optional fail-closed --expect-* checks and
 * requires confirmation before anything is signed.
 */
async function renderAndConfirmTransfer(args: string[], yes: boolean, payload: TransferPayload): Promise<RenderedIntent> {
  const rendered = renderIntent({ domain: TRANSFER_INTENT_DOMAIN, payload });
  process.stderr.write(`Review the transfer to sign (renderer v${rendered.rendererVersion}):\n${rendered.text}`);
  assertExpectations(args, rendered.payload.receiver, rendered.payload.amountAtoms);
  if (yes) {
    process.stderr.write("Confirmed by --yes.\n");
    return rendered;
  }
  if (!process.stdin.isTTY) {
    throw new IntentRenderRefusal("no interactive terminal to confirm; review the render above and pass --yes. Nothing was signed.");
  }
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = (await prompt.question("Type yes to sign this transfer: ")).trim();
    if (answer !== "yes") throw new IntentRenderRefusal("not confirmed. Nothing was signed.");
  } finally {
    prompt.close();
  }
  return rendered;
}

/** Fail-closed --expect-receiver / --expect-amount checks (feature 6A). */
function assertExpectations(args: string[], receiver: string, amountAtoms: number): void {
  const expectReceiver = option(args, "--expect-receiver");
  if (expectReceiver !== undefined) {
    let expected: string;
    try {
      expected = parseAddressInput(expectReceiver).canonical;
    } catch {
      throw new IntentRenderRefusal("--expect-receiver is not a valid address");
    }
    if (expected !== receiver) throw new IntentRenderRefusal("receiver does not match --expect-receiver");
  }
  const expectAmount = option(args, "--expect-amount");
  if (expectAmount !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(expectAmount) || !Number.isSafeInteger(Number(expectAmount))) {
      throw new IntentRenderRefusal("--expect-amount must be a whole number of atoms");
    }
    if (Number(expectAmount) !== amountAtoms) throw new IntentRenderRefusal("amount does not match --expect-amount");
  }
}

/** Broadcasts a transfer produced by `transfer-sign`. Verifies shape, txid and signature first. */
async function submitSignedTransaction(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--tx", "--rpc"]));
  const path = resolve(requiredOption(args, "--tx"));
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > 16_384) throw new Error("Signed transaction file is too large");
  const tx = JSON.parse(text) as unknown;
  validateTransactionShape(tx);
  if (tx.kind !== "transfer") throw new Error("tx-submit only broadcasts signed transfers");
  const rpc = normalizeRpcUrl(requiredOption(args, "--rpc"));
  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zyron-rpc-version": String(RPC_API_VERSION) },
    body: JSON.stringify(tx),
    signal: AbortSignal.timeout(8_000)
  });
  assertRpcApiVersion(response, RPC_API_VERSION);
  if (!response.ok) {
    throw new Error(`RPC rejected transaction: HTTP ${response.status} ${await readBoundedResponseText(response, 4_096, "RPC transaction error")}`);
  }
  const result = await readBoundedJson(response, 4_096, "RPC transaction response") as { txid?: unknown };
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
    assertValidPublicKey(key, "Validator public key");
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
  assertKnownOptions(args, new Set(["--proposal", "--approval", "--possession-proof", "--validator-admission", "--key", "--rpc"]));
  const proposal = await readValidatorProposal(resolve(requiredOption(args, "--proposal")));
  // --validator-admission true: the chain uses validatorAdmission, so the
  // field is mandatory and is sent even when empty (an update with no
  // incoming validator). false: the chain refuses the field. Absent: the field
  // is sent only when --possession-proof is given.
  const admissionOption = option(args, "--validator-admission");
  if (admissionOption !== undefined && admissionOption !== "true" && admissionOption !== "false") {
    throw new Error("--validator-admission must be true or false");
  }
  const proofPaths = options(args, "--possession-proof");
  if (admissionOption === "false" && proofPaths.length) {
    throw new Error("--possession-proof requires a chain with validatorAdmission (--validator-admission false was given)");
  }
  const suppliedProofs: ValidatorPossessionProof[] = [];
  for (const path of proofPaths) suppliedProofs.push(await readPossessionProofFile(resolve(path)));
  const privateKey = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(privateKey);
  if (addressFromPublicKey(publicKey) !== proposal.sender) throw new Error("Initiator key does not match validator proposal sender");
  const approvalPaths = options(args, "--approval");
  if (!approvalPaths.length) throw new Error("At least one --approval is required");
  const approvals: ValidatorApproval[] = [];
  for (const path of approvalPaths) approvals.push(await readValidatorApproval(resolve(path)));
  const rpc = normalizeRpcUrl(requiredOption(args, "--rpc"));
  // possession-proof-v1 (P1-07): attach the incoming validators' proofs, in
  // proposal validator order, after checking each one against this chain.
  // Which validators count as incoming (and whether the chain requires the
  // field at all) is decided by consensus; without --possession-proof the
  // transaction carries no possessionProofs field, as before.
  const possessionProofs = suppliedProofs.length
    ? await orderAndVerifyPossessionProofs(proposal, suppliedProofs, rpc)
    : admissionOption === "true" ? [] : undefined;
  const tx = createValidatorSetUpdate(
    { ...proposal, approvals, ...(possessionProofs ? { possessionProofs } : {}), timestampMs: Date.now() },
    privateKey,
    publicKey,
    proposal.transactionVersion
  );
  validateTransactionShape(tx);
  const response = await fetch(`${rpc}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zyron-rpc-version": String(RPC_API_VERSION) },
    body: JSON.stringify(tx),
    signal: AbortSignal.timeout(8_000)
  });
  assertRpcApiVersion(response, RPC_API_VERSION);
  if (!response.ok) {
    throw new Error(`RPC rejected validator update: HTTP ${response.status} ${await readBoundedResponseText(response, 4_096, "RPC validator update error")}`);
  }
  const result = await readBoundedJson(response, 4_096, "RPC validator update response") as { txid?: unknown };
  if (result.txid !== tx.txid) throw new Error("RPC validator update transaction ID mismatch");
  console.log(`Submitted validator update ${tx.txid}`);
}

async function orderAndVerifyPossessionProofs(
  proposal: ValidatorProposal,
  proofs: readonly ValidatorPossessionProof[],
  rpc: string
): Promise<ValidatorPossessionProof[]> {
  const status = await fetchJson(`${rpc}/status`) as { chainId?: unknown; genesisHash?: unknown };
  if (typeof status.genesisHash !== "string" || !/^[0-9a-f]{64}$/.test(status.genesisHash)) {
    throw new Error("RPC returned an invalid genesis hash");
  }
  if (status.chainId !== proposal.chainId) throw new Error("RPC chain ID does not match the validator proposal");
  const byAddress = new Map<string, ValidatorPossessionProof>();
  for (const proof of proofs) {
    if (byAddress.has(proof.address)) throw new Error(`Duplicate possession proof for ${proof.address}`);
    const validator = proposal.validators.find((candidate) => candidate.address === proof.address);
    if (!validator) throw new Error(`Possession proof address ${proof.address} is not in the proposed validator set`);
    const valid = verifyPossessionProof({
      chainId: proposal.chainId,
      chainBinding: status.genesisHash,
      activationHeight: proposal.activationHeight,
      address: validator.address,
      publicKey: validator.publicKey
    }, proof.signature);
    if (!valid) throw new Error(`Invalid possession proof for ${proof.address} (chain, genesis hash or activation height differ)`);
    byAddress.set(proof.address, proof);
  }
  return proposal.validators.flatMap((validator) => {
    const proof = byAddress.get(validator.address);
    return proof ? [{ address: proof.address, signature: proof.signature }] : [];
  });
}

/**
 * Signs a validator possession proof (possession-proof-v1, P1-07) with the
 * operator's own key and writes only `{ address, signature }`.
 *   --genesis <file>: genesis validator; activation height 0, chain binding =
 *     the proof-independent genesis configuration commitment.
 *   --proposal <file> --genesis-hash <hex>: validator added by a
 *     `validator_update`; activation height of the proposal, chain binding =
 *     the chain's genesis hash.
 */
async function createValidatorPossessionProofFile(args: string[]): Promise<void> {
  assertKnownOptions(args, new Set(["--genesis", "--proposal", "--genesis-hash", "--key", "--out"]));
  const genesisPath = option(args, "--genesis");
  const proposalPath = option(args, "--proposal");
  if ((genesisPath === undefined) === (proposalPath === undefined)) {
    throw new Error("Use exactly one of --genesis (genesis validator) or --proposal with --genesis-hash (validator_update)");
  }
  const output = resolve(requiredOption(args, "--out"));
  let chainId: string;
  let chainBinding: string;
  let activationHeight: number;
  let validators: readonly Validator[];
  let notListed: string;
  if (genesisPath !== undefined) {
    if (option(args, "--genesis-hash") !== undefined) throw new Error("--genesis-hash applies only to --proposal");
    const genesis = JSON.parse(await readCliGenesisUtf8(resolve(genesisPath))) as GenesisConfig;
    if (!genesis || typeof genesis !== "object" || typeof genesis.chainId !== "string" || !Array.isArray(genesis.validators)) {
      throw new Error("Invalid genesis file");
    }
    const unsigned: GenesisConfig = { ...genesis, validatorAdmission: { policy: POSSESSION_PROOF_POLICY_V1, genesisProofs: [] } };
    chainId = genesis.chainId;
    chainBinding = genesisPossessionChainBinding(unsigned);
    activationHeight = 0;
    validators = genesis.validators;
    notListed = "Key is not a genesis validator";
  } else {
    const genesisHash = requiredOption(args, "--genesis-hash");
    if (!/^[0-9a-f]{64}$/.test(genesisHash)) throw new Error("--genesis-hash must be 64 lowercase hex characters");
    const proposal = await readValidatorProposal(resolve(proposalPath!));
    chainId = proposal.chainId;
    chainBinding = genesisHash;
    activationHeight = proposal.activationHeight;
    validators = proposal.validators;
    notListed = "Key is not in the proposed validator set";
  }
  const privateKey = await readPrivateKey(resolve(requiredOption(args, "--key")));
  const publicKey = publicKeyFromPrivate(privateKey);
  const address = addressFromPublicKey(publicKey);
  const validator = validators.find((candidate) => candidate.address === address && candidate.publicKey === publicKey);
  if (!validator) throw new Error(notListed);
  const statement = { chainId, chainBinding, activationHeight, address, publicKey };
  const signature = signPossessionProof(statement, privateKey);
  if (!verifyPossessionProof(statement, signature)) throw new Error("Possession proof self-check failed");
  const proof: ValidatorPossessionProof = { address, signature };
  await writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`Possession proof written: ${output}`);
  console.log(`Signed statement (check every value before sending the proof): ${JSON.stringify(statement)}`);
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
  // F-01 §16.9-9 (policy, not consensus): v6 needs time for every operator to upgrade.
  if (isConsensusV6(protocolVersion) && activationHeight < Number(status.height) + 1 + V6_MIN_ACTIVATION_MARGIN_BLOCKS) {
    throw new Error(`Protocol v6 activation height must be at least ${Number(status.height) + 1 + V6_MIN_ACTIVATION_MARGIN_BLOCKS}`);
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
  assertRpcApiVersion(response, RPC_API_VERSION);
  if (!response.ok) {
    throw new Error(`RPC rejected protocol update: HTTP ${response.status} ${await readBoundedResponseText(response, 4_096, "RPC protocol update error")}`);
  }
  const result = await readBoundedJson(response, 4_096, "RPC protocol update response") as { txid?: unknown };
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
  assertRpcApiVersion(response, RPC_API_VERSION);
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
  return readBoundedJson(response, 64_000, "RPC response");
}

async function transactionVersionForRpc(rpc: string): Promise<TransactionVersion> {
  const response = await fetch(`${rpc}/protocol`, {
    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },
    signal: AbortSignal.timeout(8_000)
  });
  assertRpcApiVersion(response, RPC_API_VERSION);
  if (response.status === 404) return 1;
  if (!response.ok) throw new Error(`RPC protocol status returned HTTP ${response.status}`);
  const value = await readBoundedJson(response, 4_096, "RPC protocol status response") as Record<string, unknown>;
  assertObjectFields(value, ["currentVersion", "nextVersion"], "protocol status");
  if (!Number.isSafeInteger(value.currentVersion) || !Number.isSafeInteger(value.nextVersion)) {
    throw new Error("RPC returned invalid protocol status");
  }
  transactionVersionForProtocolVersion(Number(value.currentVersion));
  return transactionVersionForProtocolVersion(Number(value.nextVersion));
}

/** The next protocol version the node advertises (404 from an old node means protocol 1, as on main). */
async function advertisedProtocolForRpc(rpc: string): Promise<number> {
  const response = await fetch(`${rpc}/protocol`, {
    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },
    signal: AbortSignal.timeout(8_000)
  });
  assertRpcApiVersion(response, RPC_API_VERSION);
  if (response.status === 404) return 1;
  if (!response.ok) throw new Error(`RPC protocol status returned HTTP ${response.status}`);
  const value = await readBoundedJson(response, 4_096, "RPC protocol status response") as Record<string, unknown>;
  assertObjectFields(value, ["currentVersion", "nextVersion"], "protocol status");
  if (!Number.isSafeInteger(value.currentVersion) || !Number.isSafeInteger(value.nextVersion)) {
    throw new Error("RPC returned invalid protocol status");
  }
  transactionVersionForProtocolVersion(Number(value.currentVersion));
  transactionVersionForProtocolVersion(Number(value.nextVersion));
  // Security: sign for the currently ACTIVE protocol (the tip's version), not the scheduled next one.
  return Number(value.currentVersion);
}

async function readPrivateKey(path: string): Promise<string> {
  return readOperatorPrivateKey(path, process.env.ZYRON_KEYSTORE_PASSWORD_FILE, keystorePasswordFromEnvOrPrompt);
}

/**
 * Password source when no ZYRON_KEYSTORE_PASSWORD_FILE is set:
 * 1. ZYRON_KEYSTORE_PASSWORD (automation only; environment variables can leak to same-user
 *    processes, shell history and CI logs), otherwise
 * 2. a non-echoing prompt on the interactive terminal.
 */
async function keystorePasswordFromEnvOrPrompt(): Promise<string> {
  const fromEnv = process.env.ZYRON_KEYSTORE_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== "") {
    console.error("Warning: using ZYRON_KEYSTORE_PASSWORD from the environment (automation only). Unset it when done.");
    return fromEnv;
  }
  return promptHiddenLine("Keystore password: ");
}

async function keystorePassword(): Promise<string> {
  const file = process.env.ZYRON_KEYSTORE_PASSWORD_FILE;
  if (file) return normalizePasswordFile(await readPrivateRegularFile(resolve(file), "Keystore password file"));
  return normalizePasswordFile(await keystorePasswordFromEnvOrPrompt());
}

async function readAuthToken(path: string, label: string): Promise<string> {
  return readOperatorAuthToken(path, label);
}

async function readPossessionProofFile(path: string): Promise<ValidatorPossessionProof> {
  const value = JSON.parse(await readCliGovernanceArtifactUtf8(path)) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid possession proof file");
  assertObjectFields(value, ["address", "signature"], "possession proof");
  if (typeof value.address !== "string" || typeof value.signature !== "string" || !/^[0-9a-f]{128}$/.test(value.signature)) {
    throw new Error("Invalid possession proof file");
  }
  assertAddress(value.address);
  return { address: value.address, signature: value.signature };
}

async function readValidatorProposal(path: string): Promise<ValidatorProposal> {
  const value = JSON.parse(await readCliGovernanceArtifactUtf8(path)) as Record<string, unknown>;
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
    assertValidPublicKey(record.publicKey, "Proposal validator public key");
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
  const value = JSON.parse(await readCliGovernanceArtifactUtf8(path)) as Record<string, unknown>;
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
  const value = JSON.parse(await readCliGovernanceArtifactUtf8(path)) as Record<string, unknown>;
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
  console.log("  zyron-l1 keygen --out validator-key.json (--password-file password.txt | --password-prompt)");
  console.log("  zyron-l1 genesis --out genesis.json --chain-id zyron-devnet-1 --validator-public-key <hex> --oracle-public-key <hex> --activity-pool <address> --allocation <address:atoms>");
  console.log("  zyron-l1 node --genesis genesis.json --data ./data [--validator-key validator-key.json | --validator-signer-url https://signer/sign --validator-public-key <hex> --validator-signer-token-file signer-token.txt [--validator-signer-allow-v6 true|false]] [--peer https://node:9137] [--rpc-trusted-proxy <ip> ...] [--p2p-listen /ip4/0.0.0.0/tcp/9140] [--p2p-peer /dns4/node.example/tcp/9140/p2p/<PeerId>] [--p2p-peer-group <PeerId>=<failure-domain>] [--ready-max-tip-age-ms 600000] [--mempool-max-future-per-sender 16] [--mempool-parked-ttl-ms 600000] [--p2p-consensus-peer <PeerId> ...] [--rpc-rate-limit-exempt <loopback-ip> ...] [--rpc-submit-per-minute <n>]");
  console.log("  zyron-l1 transfer --key wallet-key.json --rpc http://127.0.0.1:9137 --chain-id zyron-devnet-1 --to <address> --amount-atoms <n> [--fee-atoms <n>] [--expect-receiver <address>] [--expect-amount <atoms>] [--yes]   (renders and asks for confirmation before signing; v2 transfers only)");
  console.log("  zyron-l1 keygen --out wallet.json --password-prompt     (interactive; no password file is written)");
  console.log("  zyron-l1 keystore-verify --key wallet.json            (password: ZYRON_KEYSTORE_PASSWORD_FILE, ZYRON_KEYSTORE_PASSWORD or a terminal prompt; prints only public data)");
  console.log("  zyron-l1 keystore-migrate --key old.json --out new.json   (v1 -> v2, scrypt N=2^17)");
  console.log("  zyron-l1 address-checksum --address <ZYN...>           (display-only mixed-case checksum; consensus uses lower-case)");
  console.log("  zyron-l1 send-check --to <ZYN...> [--from <ZYN...>] [--amount-atoms N] [--known-file book.json] [--format text|json]  (offline, advisory send warnings)");
  console.log("  zyron-l1 transfer-sign --key wallet.json --chain-id <id> --to <address> --amount-atoms <n> [--fee-atoms <n>] --nonce <next-nonce> [--tx-version 2] [--expect-receiver <address>] [--expect-amount <atoms>] [--yes] --out tx.json   (offline; version from the chain's protocol table; protocol-1 chains and v1 are refused; renders and confirms)");
  console.log("  zyron-l1 tx-submit --tx tx.json --rpc <url>");
  console.log("  zyron-l1 validator-proposal --out update.json --rpc <url> --key initiator.json --activation-height <n> --validator-public-key <hex> [...]");
  console.log("  zyron-l1 validator-approve --proposal update.json --key validator.json --out approval.json");
  console.log("  zyron-l1 validator-submit --proposal update.json --approval approval-a.json [...] [--possession-proof proof-x.json ...] [--validator-admission true|false] --key initiator.json --rpc <url>");
  console.log("  zyron-l1 validator-possession-proof --genesis genesis.json --key validator-key.json --out proof.json   (genesis validator; activation height 0)");
  console.log("  zyron-l1 validator-possession-proof --proposal update.json --genesis-hash <hex> --key validator-key.json --out proof.json   (incoming validator of a validator_update)");
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
