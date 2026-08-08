import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { createLibp2p, type Libp2p } from "libp2p";

import { publicKeyFromPrivate } from "./crypto.js";
import { nodeIdFromPublicKey, type NodeIdentity } from "./peer-identity.js";

export const DEFAULT_P2P_MAX_CONNECTIONS = 64;

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
