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
    return `ipv6:${ipv6Prefix64(normalized)}/64`;
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

function isLoopback(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "127.0.0.1" || normalized === "::ffff:127.0.0.1";
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
  if (!isLoopback(remoteAddress)) return remote;
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || forwarded.length === 0 || forwarded.length > MAX_GATEWAY_FORWARDED_HEADER_CHARS) {
    return `proxy:${remote}`;
  }
  const hops = forwarded.split(",");
  return clientAddressBucket(hops[hops.length - 1]!) ?? `proxy:${remote}`;
}
