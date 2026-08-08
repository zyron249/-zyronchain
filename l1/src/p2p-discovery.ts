import type { PeerId } from "@libp2p/interface";
import type { Libp2p } from "libp2p";
import type { Multiaddr } from "@multiformats/multiaddr";

import { nativePeerId, parseNativePeerAddress } from "./p2p-address.js";
import { readP2PFrame, writeP2PFrame } from "./p2p-frame.js";
import { P2PPeerRateLimiter } from "./p2p-rate.js";
import { validateP2PChainIdentity, type P2PChainIdentity } from "./p2p.js";
import type { NodeIdentity } from "./peer-identity.js";

export const P2P_DISCOVERY_PROTOCOL = "/zyronchain/discovery/1.0.0";
export const MAX_DISCOVERY_CANDIDATES = 32;
const MAX_DISCOVERY_FRAME_BYTES = 20_000;
const P2P_DISCOVERY_TIMEOUT_MS = 5_000;

interface DiscoveryRequest {
  version: 1;
  identity: P2PChainIdentity;
}

interface DiscoveryResponse {
  version: 1;
  identity: P2PChainIdentity;
  candidates: string[];
}

/**
 * Exchanges bounded peer hints over an already authenticated Noise session.
 * Returned addresses are deliberately only hints: callers MUST dial and run
 * the chain-identity handshake before admitting a discovered peer.
 */
export async function registerP2PDiscoveryProtocol(
  node: Libp2p,
  identity: NodeIdentity,
  chain: { chainId: string; genesisHash: string },
  advertisedPeers: () => readonly Multiaddr[]
): Promise<void> {
  const local = localIdentity(identity, chain);
  validateP2PChainIdentity(local, chain, node.peerId);
  const rate = new P2PPeerRateLimiter(60, 60_000);
  await node.handle(P2P_DISCOVERY_PROTOCOL, async (stream, connection) => {
    try {
      if (connection.encryption !== "/noise") throw new Error("Native discovery requires authenticated Noise");
      if (!rate.consume(connection.remotePeer.toString())) throw new Error("Native discovery rate limit exceeded");
      parseRequest(await readP2PFrame(stream, MAX_DISCOVERY_FRAME_BYTES, P2P_DISCOVERY_TIMEOUT_MS), chain, connection.remotePeer);
      const candidates = normalizeCandidates(advertisedPeers());
      await writeP2PFrame(stream, { version: 1, identity: local, candidates } satisfies DiscoveryResponse,
        MAX_DISCOVERY_FRAME_BYTES, P2P_DISCOVERY_TIMEOUT_MS);
      await stream.close({ signal: AbortSignal.timeout(P2P_DISCOVERY_TIMEOUT_MS) });
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error("Native discovery protocol failure"));
    }
  }, { maxInboundStreams: 2, maxOutboundStreams: 2 });
}

/** Fetches untrusted, bounded candidate hints from one chain-authenticated peer. */
export async function discoverNativePeersFrom(
  node: Libp2p,
  target: Parameters<Libp2p["dial"]>[0],
  identity: NodeIdentity,
  chain: { chainId: string; genesisHash: string }
): Promise<Multiaddr[]> {
  const connection = await node.dial(target, { signal: AbortSignal.timeout(P2P_DISCOVERY_TIMEOUT_MS) });
  if (connection.encryption !== "/noise") {
    connection.abort(new Error("Native discovery requires authenticated Noise"));
    throw new Error("Native discovery requires authenticated Noise");
  }
  const stream = await connection.newStream(P2P_DISCOVERY_PROTOCOL, { signal: AbortSignal.timeout(P2P_DISCOVERY_TIMEOUT_MS) });
  try {
    await writeP2PFrame(stream, { version: 1, identity: localIdentity(identity, chain) } satisfies DiscoveryRequest,
      MAX_DISCOVERY_FRAME_BYTES, P2P_DISCOVERY_TIMEOUT_MS);
    const response = parseResponse(
      await readP2PFrame(stream, MAX_DISCOVERY_FRAME_BYTES, P2P_DISCOVERY_TIMEOUT_MS),
      chain,
      connection.remotePeer
    );
    await stream.close({ signal: AbortSignal.timeout(P2P_DISCOVERY_TIMEOUT_MS) });
    return response;
  } catch (error) {
    stream.abort(error instanceof Error ? error : new Error("Native discovery protocol failure"));
    throw error;
  }
}

function parseRequest(
  value: unknown,
  expected: { chainId: string; genesisHash: string },
  remotePeer: Pick<PeerId, "toString">
): DiscoveryRequest {
  assertExactRecord(value, ["version", "identity"], "native discovery request");
  if (value.version !== 1) throw new Error("Invalid native discovery request");
  return { version: 1, identity: validateP2PChainIdentity(value.identity, expected, remotePeer) };
}

function parseResponse(
  value: unknown,
  expected: { chainId: string; genesisHash: string },
  remotePeer: Pick<PeerId, "toString">
): Multiaddr[] {
  assertExactRecord(value, ["version", "identity", "candidates"], "native discovery response");
  if (value.version !== 1 || !Array.isArray(value.candidates) || value.candidates.length > MAX_DISCOVERY_CANDIDATES) {
    throw new Error("Invalid native discovery response");
  }
  validateP2PChainIdentity(value.identity, expected, remotePeer);
  const seenPeerIds = new Set<string>();
  const result: Multiaddr[] = [];
  for (const candidate of value.candidates) {
    if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 512) {
      throw new Error("Invalid native discovery candidate");
    }
    let address: Multiaddr;
    try { address = parseNativePeerAddress(candidate); } catch { throw new Error("Invalid native discovery candidate"); }
    const peerId = nativePeerId(address);
    if (seenPeerIds.has(peerId)) throw new Error("Duplicate native discovery PeerId");
    seenPeerIds.add(peerId);
    result.push(address);
  }
  return result;
}

function normalizeCandidates(peers: readonly Multiaddr[]): string[] {
  if (peers.length > MAX_DISCOVERY_CANDIDATES) throw new Error("Too many native discovery candidates");
  const seenPeerIds = new Set<string>();
  return peers.map((peer) => {
    const address = parseNativePeerAddress(peer.toString());
    const peerId = nativePeerId(address);
    if (seenPeerIds.has(peerId)) throw new Error("Duplicate native discovery PeerId");
    seenPeerIds.add(peerId);
    return address.toString();
  });
}

function localIdentity(identity: NodeIdentity, chain: { chainId: string; genesisHash: string }): P2PChainIdentity {
  return { version: 1, nodeId: identity.nodeId, publicKey: identity.publicKey, chainId: chain.chainId, genesisHash: chain.genesisHash };
}

function assertExactRecord(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${name} fields`);
}
