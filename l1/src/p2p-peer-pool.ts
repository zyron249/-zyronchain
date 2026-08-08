import { BlockList } from "node:net";
import type { Libp2p } from "libp2p";
import type { Multiaddr } from "@multiformats/multiaddr";
import { peerIdFromString } from "@libp2p/peer-id";

import {
  diversityOrderedNativePeers,
  nativePeerDiversityBucket,
  nativePeerId,
  parseNativePeerAddress
} from "./p2p-address.js";
import { authenticateP2PPeer } from "./p2p.js";
import type { NodeIdentity } from "./peer-identity.js";

export const MAX_NATIVE_PEER_POOL = 64;
export const MAX_DYNAMIC_NATIVE_PEERS = 32;
export const MAX_DYNAMIC_PEERS_PER_SOURCE = 8;
export const MAX_DYNAMIC_PEERS_PER_TOPOLOGY = 2;

interface PeerEntry {
  address: Multiaddr;
  sourcePeerId?: string;
}

/**
 * Bounded peer admission. Configured seeds are operator policy; discovered
 * candidates must pass public-address policy and the Noise+chain handshake
 * before they are allowed into sync/consensus selection.
 */
export class NativePeerPool {
  private readonly peers = new Map<string, PeerEntry>();

  constructor(
    seeds: readonly Multiaddr[],
    private readonly localPeerId: string,
    private readonly peerGroups: ReadonlyMap<string, string> = new Map()
  ) {
    validatePeerId(localPeerId);
    if (seeds.length > MAX_NATIVE_PEER_POOL) throw new Error("Too many native peer seeds");
    for (const seed of seeds) {
      const address = parseNativePeerAddress(seed.toString());
      const peerId = nativePeerId(address);
      if (peerId === localPeerId) throw new Error("Native peer pool cannot contain the local PeerId");
      if (this.peers.has(peerId)) throw new Error("Duplicate native peer seed PeerId");
      this.peers.set(peerId, { address });
    }
  }

  get size(): number { return this.peers.size; }

  has(peerId: string): boolean {
    validatePeerId(peerId);
    return this.peers.has(peerId);
  }

  snapshot(groupOffset = 0): Multiaddr[] {
    return diversityOrderedNativePeers([...this.peers.values()].map((entry) => entry.address), groupOffset, this.peerGroups);
  }

  /**
   * Dials and chain-authenticates an untrusted discovery hint, then admits it
   * only if source, topology and total dynamic capacity still have room.
   */
  async verifyAndAdmit(
    node: Libp2p,
    identity: NodeIdentity,
    chain: { chainId: string; genesisHash: string },
    candidate: Multiaddr,
    sourcePeerId: string
  ): Promise<boolean> {
    validatePeerId(sourcePeerId);
    const address = assertSafeDiscoveredPeer(candidate);
    const peerId = nativePeerId(address);
    if (peerId === this.localPeerId || this.peers.has(peerId)) return false;
    if (!this.hasDynamicCapacity(address, sourcePeerId)) return false;

    // The pinned /p2p PeerId is verified by Noise during dial; the application
    // handshake additionally binds that transport identity to this chain/genesis.
    await authenticateP2PPeer(node, address, identity, chain);

    // Re-check after the asynchronous dial so concurrent discovery cannot race
    // past the capacity/failure-domain limits.
    if (peerId === this.localPeerId || this.peers.has(peerId) || !this.hasDynamicCapacity(address, sourcePeerId)) return false;
    this.peers.set(peerId, { address, sourcePeerId });
    return true;
  }

  private hasDynamicCapacity(address: Multiaddr, sourcePeerId: string): boolean {
    if (this.peers.size >= MAX_NATIVE_PEER_POOL) return false;
    const dynamic = [...this.peers.values()].filter((entry) => entry.sourcePeerId !== undefined);
    if (dynamic.length >= MAX_DYNAMIC_NATIVE_PEERS) return false;
    if (dynamic.filter((entry) => entry.sourcePeerId === sourcePeerId).length >= MAX_DYNAMIC_PEERS_PER_SOURCE) return false;
    const topology = nativePeerDiversityBucket(address);
    if (dynamic.filter((entry) => nativePeerDiversityBucket(entry.address) === topology).length >= MAX_DYNAMIC_PEERS_PER_TOPOLOGY) return false;
    return true;
  }
}

/**
 * Remote discovery is deliberately stricter than explicit operator config.
 * DNS is excluded to avoid DNS-rebinding to internal services; private,
 * loopback, link-local, documentation and reserved IP ranges are also blocked.
 */
export function assertSafeDiscoveredPeer(candidate: Multiaddr): Multiaddr {
  const address = parseNativePeerAddress(candidate.toString());
  const host = address.getComponents()[0];
  if (!host?.value || (host.name !== "ip4" && host.name !== "ip6")) {
    throw new Error("Discovered native peer must use a public IP address");
  }
  const blocked = host.name === "ip4"
    ? blockedIpv4.check(host.value, "ipv4")
    : blockedIpv6.check(host.value, "ipv6");
  if (blocked) {
    throw new Error("Discovered native peer uses a non-public IP address");
  }
  return address;
}

// Keep address families in separate BlockLists: Node represents IPv4 as
// IPv4-mapped IPv6 internally, so a mixed ::ffff:0:0/96 entry would otherwise
// make every IPv4 address appear blocked.
const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) blockedIpv4.addSubnet(network, prefix, "ipv4");
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
] as const) blockedIpv6.addSubnet(network, prefix, "ipv6");

function validatePeerId(value: string): void {
  if (value.length < 1 || value.length > 256) throw new Error("Invalid native peer pool PeerId");
  try { peerIdFromString(value); } catch { throw new Error("Invalid native peer pool PeerId"); }
}
