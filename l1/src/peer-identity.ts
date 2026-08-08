import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertHex, canonicalJson, sha256Hex } from "./codec.js";
import { generatePrivateKey, publicKeyFromPrivate, signCanonical, verifyCanonical } from "./crypto.js";
import { assertExactKeys, assertPlainRecord } from "./transaction.js";

const IDENTITY_FILE = "node-identity.json";
const MAX_PEER_ENDPOINTS = 8;
const MAX_PEER_RECORD_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PEER_RECORD_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const PEER_RECORD_DOMAIN = "ZyronChain/peer-record/v1";

export interface NodeIdentity {
  version: 1;
  nodeId: string;
  publicKey: string;
  privateKey: string;
}

export interface SignedPeerRecord {
  version: 1;
  nodeId: string;
  publicKey: string;
  chainId: string;
  genesisHash: string;
  endpoints: string[];
  issuedAtMs: number;
  expiresAtMs: number;
  signature: string;
}

interface PeerRecordPayload extends Omit<SignedPeerRecord, "signature"> {
  domain: typeof PEER_RECORD_DOMAIN;
}

export async function loadOrCreateNodeIdentity(dataDir: string): Promise<NodeIdentity> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, IDENTITY_FILE);
  try {
    return parseNodeIdentity(await readFile(path, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const privateKey = generatePrivateKey();
  const publicKey = publicKeyFromPrivate(privateKey);
  const identity: NodeIdentity = { version: 1, nodeId: nodeIdFromPublicKey(publicKey), publicKey, privateKey };
  try {
    await writeFile(path, `${canonicalJson(identity)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Concurrent startup may have won the exclusive create. Never overwrite an
    // already-established node identity; load and validate the winner instead.
    if (!isAlreadyExists(error)) throw error;
    return parseNodeIdentity(await readFile(path, "utf8"));
  }
  return identity;
}

export function createSignedPeerRecord(
  identity: NodeIdentity,
  input: {
    chainId: string;
    genesisHash: string;
    endpoints: string[];
    issuedAtMs: number;
    expiresAtMs: number;
  }
): SignedPeerRecord {
  validateNodeIdentity(identity);
  const unsigned = {
    version: 1 as const,
    nodeId: identity.nodeId,
    publicKey: identity.publicKey,
    chainId: input.chainId,
    genesisHash: input.genesisHash,
    endpoints: normalizePeerEndpoints(input.endpoints),
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs
  };
  validatePeerRecordFields(unsigned, input.issuedAtMs);
  return { ...unsigned, signature: signCanonical(peerRecordPayload(unsigned), identity.privateKey) };
}

export function validateSignedPeerRecord(
  value: unknown,
  expected: { chainId: string; genesisHash: string },
  nowMs = Date.now()
): SignedPeerRecord {
  assertPlainRecord(value, "peer record");
  assertExactKeys(value, [
    "version", "nodeId", "publicKey", "chainId", "genesisHash", "endpoints",
    "issuedAtMs", "expiresAtMs", "signature"
  ], "peer record");
  const record = value as unknown as SignedPeerRecord;
  validatePeerRecordFields(record, nowMs);
  assertHex(record.signature, 64, "peer record signature");
  if (record.chainId !== expected.chainId || record.genesisHash !== expected.genesisHash) {
    throw new Error("Peer record chain identity mismatch");
  }
  if (!verifyCanonical(peerRecordPayload(record), record.signature, record.publicKey)) {
    throw new Error("Invalid peer record signature");
  }
  return structuredClone(record);
}

export function nodeIdFromPublicKey(publicKey: string): string {
  assertHex(publicKey, 64, "node identity public key");
  return sha256Hex(Buffer.from(publicKey, "hex"));
}

function parseNodeIdentity(text: string): NodeIdentity {
  const value = JSON.parse(text) as unknown;
  assertPlainRecord(value, "node identity");
  assertExactKeys(value, ["version", "nodeId", "publicKey", "privateKey"], "node identity");
  const identity = value as unknown as NodeIdentity;
  validateNodeIdentity(identity);
  return identity;
}

function validateNodeIdentity(identity: NodeIdentity): void {
  if (identity.version !== 1) throw new Error("Unsupported node identity version");
  assertHex(identity.nodeId, 32, "node ID");
  assertHex(identity.publicKey, 64, "node identity public key");
  assertHex(identity.privateKey, 32, "node identity private key");
  let derived: string;
  try {
    derived = publicKeyFromPrivate(identity.privateKey);
  } catch {
    throw new Error("Invalid node identity private key");
  }
  if (derived !== identity.publicKey || nodeIdFromPublicKey(identity.publicKey) !== identity.nodeId) {
    throw new Error("Node identity key mismatch");
  }
}

function validatePeerRecordFields(
  record: Omit<SignedPeerRecord, "signature"> | SignedPeerRecord,
  nowMs: number
): void {
  if (record.version !== 1) throw new Error("Unsupported peer record version");
  assertHex(record.nodeId, 32, "peer node ID");
  assertHex(record.publicKey, 64, "peer public key");
  assertHex(record.genesisHash, 32, "peer genesis hash");
  if (nodeIdFromPublicKey(record.publicKey) !== record.nodeId) throw new Error("Peer node ID does not match public key");
  if (typeof record.chainId !== "string" || record.chainId.length < 1 || record.chainId.length > 64) {
    throw new Error("Invalid peer chain ID");
  }
  const normalized = normalizePeerEndpoints(record.endpoints);
  if (canonicalJson(normalized) !== canonicalJson(record.endpoints)) throw new Error("Peer endpoints are not canonical");
  if (!Number.isSafeInteger(record.issuedAtMs) || !Number.isSafeInteger(record.expiresAtMs) ||
      record.issuedAtMs < 0 || record.expiresAtMs <= record.issuedAtMs ||
      record.expiresAtMs - record.issuedAtMs > MAX_PEER_RECORD_TTL_MS) {
    throw new Error("Invalid peer record validity window");
  }
  if (record.issuedAtMs > nowMs + MAX_PEER_RECORD_CLOCK_SKEW_MS) throw new Error("Peer record issued too far in future");
  if (record.expiresAtMs <= nowMs) throw new Error("Peer record expired");
}

function normalizePeerEndpoints(values: string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PEER_ENDPOINTS) {
    throw new Error("Invalid peer endpoint count");
  }
  const endpoints = values.map((value) => {
    if (typeof value !== "string" || value.length > 512) throw new Error("Invalid peer endpoint");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Peer discovery endpoints must use clean HTTPS URLs");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  });
  return [...new Set(endpoints)].sort();
}

function peerRecordPayload(record: Omit<SignedPeerRecord, "signature"> | SignedPeerRecord): PeerRecordPayload {
  return {
    domain: PEER_RECORD_DOMAIN,
    version: 1,
    nodeId: record.nodeId,
    publicKey: record.publicKey,
    chainId: record.chainId,
    genesisHash: record.genesisHash,
    endpoints: record.endpoints,
    issuedAtMs: record.issuedAtMs,
    expiresAtMs: record.expiresAtMs
  };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST");
}
