/**
 * Port of the parts of l1/src/crypto.ts the Snap needs. Uses the same
 * @noble/curves version as l1 (pinned 2.3.0) with the same options:
 * secp256k1, SHA-256 prehash, RFC 6979 deterministic nonces, low-S, compact
 * 64-byte signatures. Signatures are therefore byte-identical to l1's.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { canonicalJson, sha256Hex } from './codec';

const SIGN_OPTIONS = {
  format: 'compact',
  prehash: true,
  lowS: true,
  extraEntropy: false,
} as const;

/**
 * l1 `publicKeyFromPrivate`: uncompressed point without the 0x04 prefix.
 *
 * @param privateKey - 32-byte secret key.
 * @returns 64-byte public key as lowercase hex.
 */
export function publicKeyFromPrivate(privateKey: Uint8Array): string {
  return bytesToHex(secp256k1.getPublicKey(privateKey, false).slice(1));
}

/**
 * l1 `addressFromPublicKey`: "ZYN" + first 20 bytes of SHA-256(pubkey64).
 *
 * @param publicKeyHex - 64-byte public key hex.
 * @returns ZyronChain address.
 */
export function addressFromPublicKey(publicKeyHex: string): string {
  const digest = sha256Hex(hexToBytes(publicKeyHex));
  return `ZYN${digest.slice(0, 40)}`;
}

/**
 * l1 `signCanonical`.
 *
 * @param payload - JSON payload.
 * @param privateKey - Secret key bytes.
 * @returns Compact signature hex.
 */
export function signCanonical(payload: unknown, privateKey: Uint8Array): string {
  const message = utf8ToBytes(canonicalJson(payload));
  return bytesToHex(secp256k1.sign(message, privateKey, SIGN_OPTIONS));
}

/**
 * l1 `verifyCanonical`.
 *
 * @param payload - JSON payload.
 * @param signatureHex - Compact signature hex.
 * @param publicKeyHex - 64-byte public key hex.
 * @returns Whether the signature is valid.
 */
export function verifyCanonical(
  payload: unknown,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    return secp256k1.verify(
      hexToBytes(signatureHex),
      utf8ToBytes(canonicalJson(payload)),
      hexToBytes(`04${publicKeyHex}`),
      { format: 'compact', prehash: true, lowS: true },
    );
  } catch {
    return false;
  }
}

/**
 * l1 `assertSigningDomain`.
 *
 * @param domain - Signing domain.
 */
export function assertSigningDomain(domain: string): void {
  if (!/^zyronchain\/[a-z0-9][a-z0-9._/-]{0,95}$/u.test(domain)) {
    throw new Error('Invalid canonical signing domain');
  }
}

/**
 * l1 `signCanonicalDomain`: signs canonicalJson({ domain, payload }).
 *
 * @param domain - Signing domain.
 * @param payload - JSON payload.
 * @param privateKey - Secret key bytes.
 * @returns Compact signature hex.
 */
export function signCanonicalDomain(
  domain: string,
  payload: unknown,
  privateKey: Uint8Array,
): string {
  assertSigningDomain(domain);
  return signCanonical({ domain, payload }, privateKey);
}

/**
 * l1 `verifyCanonicalDomain`.
 *
 * @param domain - Signing domain.
 * @param payload - JSON payload.
 * @param signatureHex - Signature hex.
 * @param publicKeyHex - Public key hex.
 * @returns Whether valid.
 */
export function verifyCanonicalDomain(
  domain: string,
  payload: unknown,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    assertSigningDomain(domain);
  } catch {
    return false;
  }
  return verifyCanonical({ domain, payload }, signatureHex, publicKeyHex);
}
