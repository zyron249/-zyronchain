import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { canonicalJson, sha256Hex } from "./codec.js";
import type { Address } from "./types.js";

const encoder = new TextEncoder();

export function publicKeyFromPrivate(privateKeyHex: string): string {
  const key = Uint8Array.from(Buffer.from(privateKeyHex, "hex"));
  const uncompressed = secp256k1.getPublicKey(key, false);
  return Buffer.from(uncompressed.slice(1)).toString("hex");
}

export function addressFromPublicKey(publicKeyHex: string): Address {
  const digest = sha256Hex(Uint8Array.from(Buffer.from(publicKeyHex, "hex")));
  return `ZYN${digest.slice(0, 40)}`;
}

/**
 * True when `publicKeyHex` is a 64-byte uncompressed x||y encoding of a point
 * on secp256k1 (the format produced by `publicKeyFromPrivate`). Membership
 * boundaries use this so that a key that can never sign cannot be counted in
 * a validator quorum denominator (F-05).
 */
export function isValidPublicKey(publicKeyHex: string): boolean {
  if (typeof publicKeyHex !== "string" || !/^[0-9a-f]{128}$/.test(publicKeyHex)) return false;
  try {
    secp256k1.Point.fromHex(`04${publicKeyHex}`).assertValidity();
    return true;
  } catch {
    return false;
  }
}

export function assertValidPublicKey(publicKeyHex: string, label: string): void {
  if (!isValidPublicKey(publicKeyHex)) throw new Error(`${label} is not a valid secp256k1 point`);
}

export function generatePrivateKey(): string {
  while (true) {
    const candidate = randomBytes(32);
    if (secp256k1.utils.isValidSecretKey(candidate)) return candidate.toString("hex");
  }
}

export function signCanonical(payload: unknown, privateKeyHex: string): string {
  return signMessageBytes(encoder.encode(canonicalJson(payload)), privateKeyHex);
}

/**
 * Signs exact message bytes (the bytes signCanonical would derive from a payload). Used by the
 * feature 6A transfer signer so it signs only the bytes rebuilt from the rendered intent.
 */
export function signMessageBytes(message: Uint8Array, privateKeyHex: string): string {
  const signature = secp256k1.sign(
    message,
    Uint8Array.from(Buffer.from(privateKeyHex, "hex")),
    { format: "compact" }
  );
  return Buffer.from(signature).toString("hex");
}

export function signCanonicalDomain(domain: string, payload: unknown, privateKeyHex: string): string {
  assertSigningDomain(domain);
  return signCanonical({ domain, payload }, privateKeyHex);
}

export function verifyCanonicalDomain(
  domain: string,
  payload: unknown,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    assertSigningDomain(domain);
  } catch {
    return false;
  }
  return verifyCanonical({ domain, payload }, signatureHex, publicKeyHex);
}

export function verifyCanonical(
  payload: unknown,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    const message = encoder.encode(canonicalJson(payload));
    const publicKey = Uint8Array.from(Buffer.from(`04${publicKeyHex}`, "hex"));
    return secp256k1.verify(
      Uint8Array.from(Buffer.from(signatureHex, "hex")),
      message,
      publicKey,
      { format: "compact" }
    );
  } catch {
    return false;
  }
}

function assertSigningDomain(domain: string): void {
  if (!/^zyronchain\/[a-z0-9][a-z0-9._/-]{0,95}$/.test(domain)) {
    throw new Error("Invalid canonical signing domain");
  }
}
