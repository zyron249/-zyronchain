import { isIP } from "node:net";

import { isGloballyReachableIp } from "./p2p-peer-pool.js";
import { nativePeerId, parseNativePeerAddress } from "./p2p-address.js";
import { isLoopbackRpcHost } from "./local-security.js";
import { assertExactKeys, assertPlainRecord } from "./transaction.js";
import type { GenesisConfig } from "./types.js";

export const PUBLIC_TESTNET_MIN_BOOTSTRAP_PEERS = 3;
export const PUBLIC_TESTNET_MAX_BOOTSTRAP_PEERS = 32;
export const PUBLIC_TESTNET_MIN_FAILURE_DOMAINS = 3;
export const PUBLIC_TESTNET_MIN_RPC_ENDPOINTS = 2;
export const PUBLIC_TESTNET_MAX_RPC_ENDPOINTS = 8;

const CHAIN_ID_PATTERN = /^zyron-public-testnet-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FAILURE_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DNS_NAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const RESERVED_DNS_SUFFIXES = new Set([
  "local", "localhost", "internal", "lan", "home", "arpa", "invalid", "test", "example", "onion"
]);

const IDENTITY_KEYS = [
  "schemaVersion",
  "status",
  "networkClass",
  "chainId",
  "genesisHash",
  "genesisTimestampMs",
  "bootstrapPeers",
  "publicRpcEndpoints",
  "activationAllowed",
  "publicMiningActivated",
  "publicationAllowed"
] as const;

export interface PublicTestnetBootstrapPeer {
  peerId: string;
  multiaddr: string;
  failureDomain: string;
}

interface PublicTestnetIdentityBase {
  schemaVersion: 1;
  networkClass: "public-testnet";
  activationAllowed: false;
  publicMiningActivated: false;
  publicationAllowed: false;
}

export interface UnfilledPublicTestnetIdentity extends PublicTestnetIdentityBase {
  status: "proposal-unfilled";
  chainId: null;
  genesisHash: null;
  genesisTimestampMs: null;
  bootstrapPeers: [];
  publicRpcEndpoints: [];
}

export interface FrozenPublicTestnetIdentity extends PublicTestnetIdentityBase {
  status: "identity-frozen";
  chainId: string;
  genesisHash: string;
  genesisTimestampMs: number;
  bootstrapPeers: PublicTestnetBootstrapPeer[];
  publicRpcEndpoints: string[];
}

export type PublicTestnetIdentity = UnfilledPublicTestnetIdentity | FrozenPublicTestnetIdentity;

export interface PublicTestnetActivationFlags {
  publicTestnetActivationAllowed: boolean;
  mainnetActivationAllowed: boolean;
}

export interface PublicTestnetAdmission {
  admitted: boolean;
  reasons: string[];
}

export function parsePublicTestnetIdentity(value: unknown): PublicTestnetIdentity {
  assertPlainRecord(value, "public-testnet identity");
  assertExactKeys(value, IDENTITY_KEYS, "public-testnet identity");
  if (value.schemaVersion !== 1) throw new Error("Invalid public-testnet identity schema version");
  if (value.networkClass !== "public-testnet") throw new Error("Invalid public-testnet identity network class");
  assertActivationStaysClosed(value.activationAllowed, "activationAllowed");
  assertActivationStaysClosed(value.publicMiningActivated, "publicMiningActivated");
  assertActivationStaysClosed(value.publicationAllowed, "publicationAllowed");
  if (value.status === "proposal-unfilled") return parseUnfilledIdentity(value);
  if (value.status === "identity-frozen") return parseFrozenIdentity(value);
  throw new Error("Invalid public-testnet identity status");
}

export function publicTestnetActivationFromAuthorization(value: unknown): PublicTestnetActivationFlags {
  assertPlainRecord(value, "launch authorization");
  if (typeof value.publicTestnetActivationAllowed !== "boolean" || typeof value.mainnetActivationAllowed !== "boolean") {
    throw new Error("Launch authorization activation flags must be booleans");
  }
  return {
    publicTestnetActivationAllowed: value.publicTestnetActivationAllowed,
    mainnetActivationAllowed: value.mainnetActivationAllowed
  };
}

/**
 * Decide whether a node may boot as the persistent public testnet.
 * The checked-in proposal is unfilled, and this function refuses it even when
 * a caller passes activation flags set to true. Activation flags inside the
 * identity file itself are rejected by the parser and are not a launch switch.
 */
export function admitPublicTestnetNode(input: {
  identity: PublicTestnetIdentity;
  genesis: GenesisConfig;
  genesisHash: string;
  activation: PublicTestnetActivationFlags;
}): PublicTestnetAdmission {
  const reasons: string[] = [];
  if (input.identity.status !== "identity-frozen") {
    reasons.push("identity-unfilled");
  } else {
    if (input.genesis.chainId !== input.identity.chainId) reasons.push("chain-id-mismatch");
    if (input.genesisHash !== input.identity.genesisHash) reasons.push("genesis-hash-mismatch");
    if (input.genesis.timestampMs !== input.identity.genesisTimestampMs) reasons.push("genesis-timestamp-mismatch");
  }
  if (input.activation.publicTestnetActivationAllowed !== true) reasons.push("public-testnet-activation-not-allowed");
  if (input.activation.mainnetActivationAllowed !== false) reasons.push("mainnet-activation-must-stay-closed");
  return { admitted: reasons.length === 0, reasons };
}

function parseUnfilledIdentity(value: Record<string, unknown>): UnfilledPublicTestnetIdentity {
  if (value.chainId !== null || value.genesisHash !== null || value.genesisTimestampMs !== null) {
    throw new Error("Unfilled public-testnet identity must keep chain ID, genesis hash, and timestamp null");
  }
  if (!Array.isArray(value.bootstrapPeers) || value.bootstrapPeers.length !== 0) {
    throw new Error("Unfilled public-testnet identity must not publish bootstrap peers");
  }
  if (!Array.isArray(value.publicRpcEndpoints) || value.publicRpcEndpoints.length !== 0) {
    throw new Error("Unfilled public-testnet identity must not publish RPC endpoints");
  }
  return {
    schemaVersion: 1,
    status: "proposal-unfilled",
    networkClass: "public-testnet",
    chainId: null,
    genesisHash: null,
    genesisTimestampMs: null,
    bootstrapPeers: [],
    publicRpcEndpoints: [],
    activationAllowed: false,
    publicMiningActivated: false,
    publicationAllowed: false
  };
}

function parseFrozenIdentity(value: Record<string, unknown>): FrozenPublicTestnetIdentity {
  if (typeof value.chainId !== "string" || !CHAIN_ID_PATTERN.test(value.chainId) || value.chainId.length > 64 || value.chainId.includes("mainnet")) {
    throw new Error("Frozen public-testnet chain ID must match zyron-public-testnet-<label> and must not name mainnet");
  }
  if (typeof value.genesisHash !== "string" || !/^[0-9a-f]{64}$/.test(value.genesisHash)) {
    throw new Error("Frozen public-testnet genesis hash must be 64 lowercase hex characters");
  }
  if (!Number.isSafeInteger(value.genesisTimestampMs) || Number(value.genesisTimestampMs) < 0) {
    throw new Error("Frozen public-testnet genesis timestamp is invalid");
  }
  return {
    schemaVersion: 1,
    status: "identity-frozen",
    networkClass: "public-testnet",
    chainId: value.chainId,
    genesisHash: value.genesisHash,
    genesisTimestampMs: value.genesisTimestampMs as number,
    bootstrapPeers: parseBootstrapPeers(value.bootstrapPeers),
    publicRpcEndpoints: parseRpcEndpoints(value.publicRpcEndpoints),
    activationAllowed: false,
    publicMiningActivated: false,
    publicationAllowed: false
  };
}

function parseBootstrapPeers(value: unknown): PublicTestnetBootstrapPeer[] {
  if (!Array.isArray(value) || value.length < PUBLIC_TESTNET_MIN_BOOTSTRAP_PEERS || value.length > PUBLIC_TESTNET_MAX_BOOTSTRAP_PEERS) {
    throw new Error("Frozen public-testnet identity requires 3 to 32 bootstrap peers");
  }
  const peers: PublicTestnetBootstrapPeer[] = [];
  const peerIds = new Set<string>();
  const multiaddrs = new Set<string>();
  const domains = new Set<string>();
  for (const entry of value) {
    assertPlainRecord(entry, "public-testnet bootstrap peer");
    assertExactKeys(entry, ["peerId", "multiaddr", "failureDomain"], "public-testnet bootstrap peer");
    if (typeof entry.peerId !== "string" || typeof entry.multiaddr !== "string" || typeof entry.failureDomain !== "string") {
      throw new Error("Invalid public-testnet bootstrap peer");
    }
    if (!FAILURE_DOMAIN_PATTERN.test(entry.failureDomain)) throw new Error("Invalid public-testnet failure domain");
    const address = parseNativePeerAddress(entry.multiaddr);
    if (nativePeerId(address) !== entry.peerId) throw new Error("Bootstrap multiaddr peer ID does not match peerId");
    assertPublicBootstrapHost(address);
    if (peerIds.has(entry.peerId) || multiaddrs.has(address.toString())) throw new Error("Duplicate public-testnet bootstrap peer");
    peerIds.add(entry.peerId);
    multiaddrs.add(address.toString());
    domains.add(entry.failureDomain);
    peers.push({ peerId: entry.peerId, multiaddr: address.toString(), failureDomain: entry.failureDomain });
  }
  if (domains.size < PUBLIC_TESTNET_MIN_FAILURE_DOMAINS) {
    throw new Error("Frozen public-testnet identity requires at least 3 distinct failure domains");
  }
  return peers;
}

function assertPublicBootstrapHost(address: ReturnType<typeof parseNativePeerAddress>): void {
  const host = address.getComponents()[0];
  if (!host?.value) throw new Error("Bootstrap peer has no host");
  if (host.name === "ip4" || host.name === "ip6") {
    const family = host.name === "ip4" ? "ipv4" : "ipv6";
    if (!isGloballyReachableIp(host.value, family)) throw new Error("Bootstrap peer uses a non-public IP address");
    return;
  }
  if (host.name !== "dns4" && host.name !== "dns6") throw new Error("Bootstrap peer host must be a public IP or dns4/dns6 name");
  assertPublicDnsName(host.value);
}

function parseRpcEndpoints(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < PUBLIC_TESTNET_MIN_RPC_ENDPOINTS || value.length > PUBLIC_TESTNET_MAX_RPC_ENDPOINTS) {
    throw new Error("Frozen public-testnet identity requires 2 to 8 HTTPS RPC endpoints");
  }
  const origins = new Set<string>();
  const endpoints: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("Invalid public-testnet RPC endpoint");
    const origin = canonicalPublicRpcOrigin(entry);
    if (origins.has(origin)) throw new Error("Duplicate public-testnet RPC origin");
    origins.add(origin);
    endpoints.push(origin);
  }
  return endpoints;
}

function canonicalPublicRpcOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid public-testnet RPC endpoint");
  }
  if (url.protocol !== "https:") throw new Error("Public-testnet RPC endpoint must use HTTPS");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Public-testnet RPC endpoint must be an origin without credentials, path, query, or fragment");
  }
  const hostname = normalizeUrlHostname(url.hostname);
  if (isLoopbackRpcHost(hostname) || isLoopbackRpcHost(url.hostname)) {
    throw new Error("Public-testnet RPC endpoint must not be loopback");
  }
  const family = isIP(hostname);
  if (family === 4 || family === 6) {
    if (!isGloballyReachableIp(hostname, family === 4 ? "ipv4" : "ipv6")) {
      throw new Error("Public-testnet RPC endpoint uses a non-public IP address");
    }
  } else {
    assertPublicDnsName(hostname);
  }
  return url.origin;
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function assertPublicDnsName(hostname: string): void {
  if (hostname !== hostname.toLowerCase() || hostname.endsWith(".")) throw new Error("Public DNS name must be lowercase and canonical");
  if (!DNS_NAME_PATTERN.test(hostname)) throw new Error("Invalid public DNS name");
  const suffix = hostname.split(".").at(-1);
  if (suffix === undefined || RESERVED_DNS_SUFFIXES.has(suffix)) throw new Error("Public DNS name uses a reserved suffix");
}

function assertActivationStaysClosed(value: unknown, name: string): asserts value is false {
  if (value !== false) {
    throw new Error(`Public-testnet identity cannot grant ${name}; activation stays in launch authorization`);
  }
}
