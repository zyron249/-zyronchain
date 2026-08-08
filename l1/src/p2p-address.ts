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
  if (host.name === "ip6") return `ipv6:${value}`;
  return `host:${value}`;
}

export function diversityOrderedNativePeers(peers: readonly Multiaddr[], groupOffset = 0): Multiaddr[] {
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
  return result;
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
