import { createHash } from "node:crypto";

import type { Address } from "./types.js";

/**
 * Display-only address checksum (ZYN mixed-case, "ZMC-1").
 *
 * Consensus addresses are unchanged: "ZYN" + 40 lower-case hex. For display and input
 * validation only, each hex letter a-f at body position i is upper-cased when nibble i of
 * SHA-256("zyronchain/address-checksum/v1:" + canonicalAddress) is >= 8 (EIP-55 adapted to
 * SHA-256 with a domain tag). Lower-casing the body always yields the canonical consensus
 * form, so every existing address stays valid and nothing on-chain changes.
 */
export const ADDRESS_CHECKSUM_DOMAIN = "zyronchain/address-checksum/v1:";

const CANONICAL_RE = /^ZYN[0-9a-f]{40}$/;
const INPUT_RE = /^ZYN[0-9a-fA-F]{40}$/;

export function toChecksumAddress(address: string): string {
  if (!CANONICAL_RE.test(address)) throw new Error("Address must be canonical: ZYN + 40 lower-case hex");
  const hash = createHash("sha256").update(`${ADDRESS_CHECKSUM_DOMAIN}${address}`, "utf8").digest("hex");
  const body = address.slice(3);
  let out = "ZYN";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    out += char >= "a" && char <= "f" && parseInt(hash[index]!, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

export interface ParsedAddressInput {
  canonical: Address;
  checksummed: string;
  /** True when the input carried a checksum (mixed case) and it matched. */
  checksumVerified: boolean;
}

/**
 * Accepts the canonical lower-case form (no checksum to verify) or the mixed-case checksum
 * form (verified exactly). Anything else, including a wrong checksum, is rejected.
 */
export function parseAddressInput(input: string): ParsedAddressInput {
  if (typeof input !== "string" || !INPUT_RE.test(input)) {
    throw new Error("Invalid address: expected ZYN followed by 40 hex characters");
  }
  const canonical = `ZYN${input.slice(3).toLowerCase()}` as Address;
  const checksummed = toChecksumAddress(canonical);
  if (input === canonical) return { canonical, checksummed, checksumVerified: false };
  if (input !== checksummed) {
    throw new Error("Address checksum mismatch: the mixed-case letters do not match (likely a typo)");
  }
  return { canonical, checksummed, checksumVerified: true };
}
