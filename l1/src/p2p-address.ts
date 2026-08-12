import { isIP } from "node:net";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";

const MAX_NATIVE_P2P_ADDRESS_LENGTH = 512;

export function parseNativeListenAddress(value: string): Multiaddr {
  return parseNativeTcpAddress(value, false);
}

export function parseNativePeerAddress(value: string): Multiaddr {
  return parseNativeTcpAddress(value, true);
}

export function nativePeerAddressHost(value: string): string {
  const address = parseNativePeerAddress(value);
  const component = address.getComponents().find((item) => ["ip4", "ip6", "dns", "dns4", "dns6"].includes(item.name));
  if (!component?.value) throw new Error("Native P2P peer address is missing a host");
  return component.value.toLowerCase();
}

export function nativePeerFailureDomain(value: string): string {
  const address = parseNativePeerAddress(value);
  const component = address.getComponents().find((item) => ["ip4", "ip6", "dns", "dns4", "dns6"].includes(item.name));
  if (!component?.value) throw new Error("Native P2P peer address is missing a host");
  const host = component.value.toLowerCase();
  if (component.name === "ip4") {
    const octets = host.split(".");
    return `ipv4:${octets.slice(0, 3).join(".")}.0/24`;
  }
  if (component.name === "ip6") return `ipv6:${ipv6Prefix64(host)}/64`;
  return `host:${host}`;
}

export function nativePeerPinnedId(value: string): string {
  const address = parseNativePeerAddress(value);
  const peer = address.getComponents().find((component) => component.name === "p2p");
  if (!peer?.value) throw new Error("Native P2P peer address must pin a PeerId");
  return peer.value;
}

export function nativePeerDialAddress(value: string): Multiaddr {
  const address = parseNativePeerAddress(value);
  const components = address.getComponents().filter((component) => component.name !== "p2p");
  return multiaddr(`/${components.map((component) => `${component.name}/${component.value}`).join("/")}`);
}

export function nativePeerAddressKey(value: string): string {
  return parseNativePeerAddress(value).toString();
}

export function nativePeerTransportAddress(value: string): string {
  const address = parseNativePeerAddress(value);
  const components = address.getComponents().filter((component) => component.name !== "p2p");
  return `/${components.map((component) => `${component.name}/${component.value}`).join("/")}`;
}

export function assertPublicNativePeerAddress(value: string): void {
  const host = nativePeerAddressHost(value);
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    if (
      octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) ||
      (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) ||
      (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) ||
      (octets[0] === 198 && octets[1] === 18) ||
      (octets[0] === 198 && octets[1] === 19) ||
      (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
      (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
      octets[0]! >= 224
    ) throw new Error("Native P2P peer address must use a public IP");
    return;
  }
  if (isIP(host) === 6) {
    const normalized = host.toLowerCase();
    if (
      normalized === "::" || normalized === "::1" ||
      /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("2001:db8:")
    ) throw new Error("Native P2P peer address must use a public IP");
    return;
  }
  throw new Error("Discovered native P2P peer addresses must use literal public IPs");
}

function parseNativeTcpAddress(value: string, peer: boolean): Multiaddr {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NATIVE_P2P_ADDRESS_LENGTH) {
    throw new Error(`Invalid native P2P ${peer ? "peer" : "listen"} address`);
  }
  let address: Multiaddr;
  try {
    address = multiaddr(value);
  } catch {
    throw new Error(`Invalid native P2P ${peer ? "peer" : "listen"} address`);
  }
  const components = address.getComponents();
  const allowed = new Set(["ip4", "ip6", "dns", "dns4", "dns6", "tcp", ...(peer ? ["p2p"] : [])]);
  const peerIds = components.filter((component) => component.name === "p2p");
  if (peer && peerIds.length !== 1) throw new Error("Native P2P peer address must pin exactly one PeerId");
  if (!peer && peerIds.length !== 0) throw new Error("Native P2P listen address must not pin a PeerId");
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
