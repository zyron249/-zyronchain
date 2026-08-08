import { privateKeyFromRaw, publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { createLibp2p, type Libp2p } from "libp2p";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { PeerId, Stream } from "@libp2p/interface";

import { publicKeyFromPrivate } from "./crypto.js";
import { nodeIdFromPublicKey, type NodeIdentity } from "./peer-identity.js";
import { P2PPeerRateLimiter } from "./p2p-rate.js";

export const DEFAULT_P2P_MAX_CONNECTIONS = 64;
export const P2P_IDENTITY_PROTOCOL = "/zyronchain/identity/1.0.0";
const MAX_IDENTITY_MESSAGE_BYTES = 2_048;
const IDENTITY_STREAM_TIMEOUT_MS = 5_000;

export interface P2PChainIdentity {
  version: 1;
  nodeId: string;
  publicKey: string;
  chainId: string;
  genesisHash: string;
}

export interface P2PNodeOptions {
  listen?: string[];
  maxConnections?: number;
}

/**
 * Creates the encrypted transport foundation for ZyronChain's native P2P
 * protocol. The existing persistent node identity is reused as libp2p's
 * secp256k1 identity; validator signing keys are never involved.
 *
 * Application protocols are intentionally registered in later layers so no
 * caller can mistake an encrypted connection alone for chain authentication.
 */
export async function createP2PNode(
  identity: NodeIdentity,
  options: P2PNodeOptions = {}
): Promise<Libp2p> {
  assertIdentityBinding(identity);
  const maxConnections = options.maxConnections ?? DEFAULT_P2P_MAX_CONNECTIONS;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 1_024) {
    throw new Error("Invalid P2P max connection limit");
  }
  const listen = options.listen ?? [];
  if (!Array.isArray(listen) || listen.length > 8 || listen.some((address) => typeof address !== "string" || address.length > 512)) {
    throw new Error("Invalid P2P listen addresses");
  }
  const privateKey = privateKeyFromRaw(Buffer.from(identity.privateKey, "hex"));
  if (privateKey.type !== "secp256k1") throw new Error("Node identity is not a secp256k1 libp2p key");

  return createLibp2p({
    privateKey,
    addresses: { listen: [...listen] },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    connectionManager: {
      maxConnections
    }
  });
}

/**
 * Registers the first native ZyronChain application protocol. Noise already
 * authenticates the libp2p transport key; this exchange binds that authenticated
 * PeerId to ZyronChain's nodeId/public key and to one exact chain genesis.
 */
export async function registerP2PIdentityProtocol(
  node: Libp2p,
  identity: NodeIdentity,
  chain: { chainId: string; genesisHash: string },
  onAuthenticated?: (remote: P2PChainIdentity) => void
): Promise<void> {
  assertIdentityBinding(identity);
  const local = createChainIdentity(identity, chain);
  const rate = new P2PPeerRateLimiter(120, 60_000);
  await node.handle(P2P_IDENTITY_PROTOCOL, async (stream, connection) => {
    try {
      if (!rate.consume(connection.remotePeer.toString())) throw new Error("P2P identity rate limit exceeded");
      const remote = await exchangeIdentity(stream, local, chain, connection.remotePeer);
      onAuthenticated?.(remote);
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("P2P identity authentication failed"));
    }
  }, { maxInboundStreams: 2, maxOutboundStreams: 2 });
}

/** Opens an identity stream and succeeds only for the expected ZyronChain. */
export async function authenticateP2PPeer(
  node: Libp2p,
  target: Parameters<Libp2p["dialProtocol"]>[0],
  identity: NodeIdentity,
  chain: { chainId: string; genesisHash: string }
): Promise<P2PChainIdentity> {
  assertIdentityBinding(identity);
  const connection = await node.dial(target, {
    signal: AbortSignal.timeout(IDENTITY_STREAM_TIMEOUT_MS)
  });
  if (connection.encryption !== "/noise") {
    connection.abort(new Error("P2P identity protocol requires authenticated Noise"));
    throw new Error("P2P identity protocol requires authenticated Noise");
  }
  const stream = await connection.newStream(P2P_IDENTITY_PROTOCOL, {
    signal: AbortSignal.timeout(IDENTITY_STREAM_TIMEOUT_MS)
  });
  try {
    return await exchangeIdentity(stream, createChainIdentity(identity, chain), chain, connection.remotePeer);
  } catch (error) {
    stream.abort(error instanceof Error ? error : new Error("P2P identity authentication failed"));
    throw error;
  }
}

export function validateP2PChainIdentity(
  value: unknown,
  expected: { chainId: string; genesisHash: string },
  remotePeer: Pick<PeerId, "toString">
): P2PChainIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid P2P identity message");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ["chainId", "genesisHash", "nodeId", "publicKey", "version"].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Invalid P2P identity message fields");
  }
  if (record.version !== 1 || typeof record.nodeId !== "string" || !/^[0-9a-f]{64}$/.test(record.nodeId) ||
      typeof record.publicKey !== "string" || !/^[0-9a-f]{128}$/.test(record.publicKey) ||
      typeof record.chainId !== "string" || record.chainId.length < 1 || record.chainId.length > 128 ||
      typeof record.genesisHash !== "string" || !/^[0-9a-f]{64}$/.test(record.genesisHash)) {
    throw new Error("Invalid P2P identity message");
  }
  if (record.chainId !== expected.chainId || record.genesisHash !== expected.genesisHash) {
    throw new Error("P2P chain identity mismatch");
  }
  if (nodeIdFromPublicKey(record.publicKey) !== record.nodeId) throw new Error("P2P node ID mismatch");
  if (peerIdFromZyronPublicKey(record.publicKey).toString() !== remotePeer.toString()) {
    throw new Error("P2P Noise identity mismatch");
  }
  return structuredClone(record) as unknown as P2PChainIdentity;
}

function createChainIdentity(identity: NodeIdentity, chain: { chainId: string; genesisHash: string }): P2PChainIdentity {
  return validateP2PChainIdentityFields({
    version: 1,
    nodeId: identity.nodeId,
    publicKey: identity.publicKey,
    chainId: chain.chainId,
    genesisHash: chain.genesisHash
  });
}

function validateP2PChainIdentityFields(value: P2PChainIdentity): P2PChainIdentity {
  if (value.chainId.length < 1 || value.chainId.length > 128 || !/^[0-9a-f]{64}$/.test(value.genesisHash)) {
    throw new Error("Invalid local P2P chain identity");
  }
  return value;
}

async function exchangeIdentity(
  stream: Stream,
  local: P2PChainIdentity,
  expected: { chainId: string; genesisHash: string },
  remotePeer: Pick<PeerId, "toString">
): Promise<P2PChainIdentity> {
  stream.inactivityTimeout = IDENTITY_STREAM_TIMEOUT_MS;
  const encoded = Buffer.from(`${JSON.stringify(local)}\n`, "utf8");
  if (encoded.length > MAX_IDENTITY_MESSAGE_BYTES) throw new Error("Local P2P identity message too large");
  if (!stream.send(encoded)) await stream.onDrain({ signal: AbortSignal.timeout(IDENTITY_STREAM_TIMEOUT_MS) });
  const chunks: Buffer[] = [];
  let total = 0;
  let framed: Buffer | undefined;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk.subarray());
    total += bytes.length;
    if (total > MAX_IDENTITY_MESSAGE_BYTES) throw new Error("P2P identity message too large");
    chunks.push(bytes);
    const accumulated = Buffer.concat(chunks, total);
    const delimiter = accumulated.indexOf(0x0a);
    if (delimiter !== -1) {
      if (delimiter !== accumulated.length - 1) throw new Error("Invalid P2P identity message framing");
      framed = accumulated.subarray(0, delimiter);
      break;
    }
  }
  if (!framed || framed.length === 0) throw new Error("Missing P2P identity message");
  let value: unknown;
  try {
    value = JSON.parse(framed.toString("utf8"));
  } catch {
    throw new Error("Invalid P2P identity message encoding");
  }
  const validated = validateP2PChainIdentity(value, expected, remotePeer);
  await stream.close({ signal: AbortSignal.timeout(IDENTITY_STREAM_TIMEOUT_MS) });
  return validated;
}

function peerIdFromZyronPublicKey(publicKey: string): PeerId {
  const point = secp256k1.Point.fromHex(`04${publicKey}`);
  point.assertValidity();
  const libp2pKey = publicKeyFromRaw(point.toBytes(true));
  if (libp2pKey.type !== "secp256k1") throw new Error("Invalid P2P secp256k1 public key");
  return peerIdFromPublicKey(libp2pKey);
}

function assertIdentityBinding(identity: NodeIdentity): void {
  if (identity.version !== 1 || !/^[0-9a-f]{64}$/.test(identity.privateKey) ||
      !/^[0-9a-f]{128}$/.test(identity.publicKey) || !/^[0-9a-f]{64}$/.test(identity.nodeId)) {
    throw new Error("Invalid persistent node identity for P2P transport");
  }
  let publicKey: string;
  try {
    publicKey = publicKeyFromPrivate(identity.privateKey);
  } catch {
    throw new Error("Invalid persistent node identity for P2P transport");
  }
  if (publicKey !== identity.publicKey || nodeIdFromPublicKey(publicKey) !== identity.nodeId) {
    throw new Error("Persistent node identity does not bind P2P transport key");
  }
}
