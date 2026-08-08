import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";

export function parseNativeListenAddress(value: string): string {
  const address = parseNativeTcpAddress(value, false);
  if (address.getComponents().some((component) => component.name === "p2p")) {
    throw new Error("Native P2P listen address must not include a peer ID");
  }
  return address.toString();
}

export function parseNativePeerAddress(value: string): Multiaddr {
  const address = parseNativeTcpAddress(value, true);
  const peerIds = address.getComponents().filter((component) => component.name === "p2p" && component.value);
  if (peerIds.length !== 1) throw new Error("Configured native peer must pin exactly one /p2p/<PeerId>");
  return address;
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
