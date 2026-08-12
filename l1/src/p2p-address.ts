import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";

export function parseNativeListenAddress(value: string): string {
  const address = parseNativeTcpAddress(value, false);
  const components = address.getComponents();
  if (components.some((component) => component.name === "p2p")) {
    throw new Error("Native P2P listen address must not include a peer ID");
  }
  if (components.length !== 2) throw new Error("Native P2P listen address must be host/TCP only");
  return address.toString();
}

export function parseNativePeerAddress(value: string): Multiaddr {
  const address = parseNativeTcpAddress(value, true);
  const components = address.getComponents();
  const peerIds = components.filter((component) => component.name === "p2p" && component.value);
  if (peerIds.length !== 1) throw new Error("Configured native peer must pin exactly one /p2p/<PeerId>");
  if (components.length !== 3 || components[2]?.name !== "p2p") {
    throw new Error("Configured native peer must be host/TCP/p2p only");
  }
  return address;
}

export function nativePeerDiversityBucket(peer: Multiaddr): string {
  const host = peer.getComponents().find((component) => ["ip4", "ip6", "dns", "dns4", "dns6"].includes(component.name));
  if (!host?.value) throw new Error("Native peer has no diversity host");
  const value = host.value.toLowerCase();
  if (host.name === "ip4") {
    const octets = value.split(".");
    return `ipv4:${octets.slice(0, 3).join(".")}.0/24`;
  }
  if (host.name === "ip6") return `ipv6:${ipv6Prefix64(value)}/64`;
  return `host:${value}`;
}

export function nativePeerId(peer: Multiaddr): string {
  const component = peer.getComponents().find((item) => item.name === "p2p" && item.value);
  if (!component?.value) throw new Error("Native peer has no pinned PeerId");
  return component.value;
}

export function parseNativePeerGroup(value: string): { peerId: string; group: string } {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) throw new Error("Native peer group must be <PeerId>=<group>");
  const peerId = value.slice(0, separator);
  const group = value.slice(separator + 1);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(group)) throw new Error("Invalid native peer group label");
  try {
    // Reuse multiaddr's reviewed PeerId codec for syntax validation.
    multiaddr(`/p2p/${peerId}`);
  } catch {
    throw new Error("Invalid native peer group PeerId");
  }
  return { peerId, group };
}

export function diversityOrderedNativePeers(
  peers: readonly Multiaddr[],
  groupOffset = 0,
  peerGroups: ReadonlyMap<string, string> = new Map()
): Multiaddr[] {
  const unique = new Map(peers.map((peer) => [peer.toString(), peer]));
  const groups = new Map<string, Multiaddr[]>();
  for (const peer of unique.values()) {
    const key = nativePeerDiversityBucket(peer);
    const group = groups.get(key) ?? [];
    group.push(peer);
    groups.set(key, group);
  }
  const values = [...groups.values()];
  if (values.length === 0) return [];
  const offset = ((groupOffset % values.length) + values.length) % values.length;
  const rotated = [...values.slice(offset), ...values.slice(0, offset)];
  const result: Multiaddr[] = [];
  const rounds = Math.max(...rotated.map((group) => group.length));
  for (let index = 0; index < rounds; index += 1) {
    for (const group of rotated) if (group[index]) result.push(group[index]!);
  }
  if (peerGroups.size === 0) return result;

  // Operator-supplied groups represent an independent failure domain such as
  // ASN, cloud provider or common operator. Preserve topology interleaving and
  // additionally avoid selecting the same named failure domain twice per round.
  const remaining = [...result];
  const groupedResult: Multiaddr[] = [];
  while (remaining.length) {
    const usedTopology = new Set<string>();
    const usedOperatorGroups = new Set<string>();
    let selectedThisRound = 0;
    for (let index = 0; index < remaining.length;) {
      const peer = remaining[index]!;
      const topology = nativePeerDiversityBucket(peer);
      const operatorGroup = peerGroups.get(nativePeerId(peer));
      if (usedTopology.has(topology) || (operatorGroup !== undefined && usedOperatorGroups.has(operatorGroup))) {
        index += 1;
        continue;
      }
      groupedResult.push(peer);
      usedTopology.add(topology);
      if (operatorGroup !== undefined) usedOperatorGroups.add(operatorGroup);
      remaining.splice(index, 1);
      selectedThisRound += 1;
    }
    if (selectedThisRound === 0) groupedResult.push(remaining.shift()!);
  }
  return groupedResult;
}

function parseNativeTcpAddress(value: string, peer: boolean): Multiaddr {
  let address: Multiaddr;
  try {
    address = multiaddr(value);
  } catch {
    throw new Error(`Invalid native P2P ${peer ? "peer" : "listen"} multiaddr`);
  }
  const components = address.getComponents();
  const allowed = new Set(["ip4", "ip6", "dns", "dns4", "dns6", "tcp", "p2p"]);
  const hosts = components.filter((component) => ["ip4", "ip6", "dns", "dns4", "dns6"].includes(component.name));
  const tcp = components.filter((component) => component.name === "tcp");
  if (components.some((component) => !allowed.has(component.name)) || hosts.length !== 1 || tcp.length !== 1) {
    throw new Error(`Native P2P ${peer ? "peer" : "listen"} must be one host + TCP multiaddr`);
  }
  return address;
}

export function ipv6Prefix64(value: string): string {
  const normalized = value.toLowerCase();
  const halves = normalized.split("::");
  if (halves.length > 2) throw new Error("Invalid native peer IPv6 host");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const expandIpv4 = (parts: string[]): string[] => parts.flatMap((part) => {
    if (!part.includes(".")) return [part];
    const octets = part.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      throw new Error("Invalid native peer IPv6 host");
    }
    return [((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16)];
  });
  const expandedLeft = expandIpv4(left);
  const expandedRight = expandIpv4(right);
  const missing = 8 - expandedLeft.length - expandedRight.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new Error("Invalid native peer IPv6 host");
  }
  const hextets = [...expandedLeft, ...Array.from({ length: missing }, () => "0"), ...expandedRight];
  if (hextets.length !== 8 || hextets.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    throw new Error("Invalid native peer IPv6 host");
  }
  return hextets.slice(0, 4).map((part) => part.padStart(4, "0")).join(":");
}
