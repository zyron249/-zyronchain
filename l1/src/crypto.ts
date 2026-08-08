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

export function generatePrivateKey(): string {
  while (true) {
    const candidate = randomBytes(32);
    if (secp256k1.utils.isValidSecretKey(candidate)) return candidate.toString("hex");
  }
}

export function signCanonical(payload: unknown, privateKeyHex: string): string {
  const message = encoder.encode(canonicalJson(payload));
  const signature = secp256k1.sign(
    message,
    Uint8Array.from(Buffer.from(privateKeyHex, "hex")),
    { format: "compact" }
  );
  return Buffer.from(signature).toString("hex");
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
