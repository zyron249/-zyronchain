import { isIP } from "node:net";

import { ipv6Prefix64 } from "./p2p-address.js";

/**
 * Longest forwarding header the gateways inspect. A longer header is not
 * parsed and fails closed to the transport peer's bucket.
 */
export const MAX_GATEWAY_FORWARDED_HEADER_CHARS = 1_024;

/**
 * Rate-limit bucket for one client IP literal: IPv4 (and IPv4-mapped IPv6)
 * per address, IPv6 per /64. An IPv6 end site normally holds at least a /64,
 * so per-/128 buckets would give one host up to 2^64 independent quotas.
 * Returns undefined for anything that is not a plain IP literal (host names,
 * ports, zone ids, malformed text).
 */
export function clientAddressBucket(value: string): string | undefined {
  if (value.length > 64) return undefined;
  const normalized = value.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  if (isIP(mapped) === 4) return mapped;
  if (normalized.includes("%") || isIP(normalized) !== 6) return undefined;
  try {
    // Canonical form (WHATWG URL host serializer): every IPv4-mapped spelling
    // (dotted, hexadecimal, expanded) becomes ::ffff:<hex>:<hex>. Those
    // addresses all share one /64, so they are bucketed as their IPv4 address.
    const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1]!, 16);
      const low = Number.parseInt(mappedHex[2]!, 16);
      return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    }
    return `ipv6:${ipv6Prefix64(canonical)}/64`;
  } catch {
    return undefined;
  }
}

export interface GatewayClientIdentityOptions {
  /**
   * True only when every request reaches the gateway through Cloudflare, which
   * sets CF-Connecting-IP itself (Render web services). Never enable it for a
   * gateway that clients can reach directly.
   */
  trustCloudflareConnectingIp: boolean;
}

/**
 * True for every loopback address in any IP-literal spelling: 127.0.0.0/8
 * (also IPv4-mapped, dotted or hexadecimal) and ::1. All of them are the same
 * local trust boundary (R14-1037-L1: a local proxy on 127.0.0.2 or a
 * non-canonical spelling must not lose its appended X-Forwarded-For entry).
 */
export function isLoopbackAddress(address: string): boolean {
  const bucket = clientAddressBucket(address);
  if (bucket === undefined) return false;
  if (isIP(bucket) === 4) return bucket.startsWith("127.");
  const normalized = address.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  try {
    return new URL(`http://[${normalized}]/`).hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Client identity for the public testnet gateways' rate limits.
 *
 * - With trustCloudflareConnectingIp: the CF-Connecting-IP header, which the
 *   Cloudflare edge sets and clients cannot choose. Missing or malformed:
 *   the shared `proxy:<transport>` bucket.
 * - Otherwise, from a loopback transport (a local reverse proxy or tunnel):
 *   the rightmost X-Forwarded-For entry, which that proxy appended. The
 *   entries to its left are client-supplied text and are never used.
 *   Missing, malformed or oversized: the shared `proxy:<transport>` bucket.
 * - Otherwise: the transport peer address; forwarding headers are ignored.
 */
export function gatewayClientIdentity(
  remoteAddress: string | undefined,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  options: GatewayClientIdentityOptions
): string {
  if (remoteAddress === undefined) return "unknown";
  const remote = clientAddressBucket(remoteAddress);
  if (remote === undefined) return "unknown";
  if (options.trustCloudflareConnectingIp) {
    const edge = headers["cf-connecting-ip"];
    const client = typeof edge === "string" ? clientAddressBucket(edge) : undefined;
    return client ?? `proxy:${remote}`;
  }
  if (!isLoopbackAddress(remoteAddress)) return remote;
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || forwarded.length === 0 || forwarded.length > MAX_GATEWAY_FORWARDED_HEADER_CHARS) {
    return `proxy:${remote}`;
  }
  const hops = forwarded.split(",");
  return clientAddressBucket(hops[hops.length - 1]!) ?? `proxy:${remote}`;
}
