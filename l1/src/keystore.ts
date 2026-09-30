import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { addressFromPublicKey, publicKeyFromPrivate } from "./crypto.js";

const KEYSTORE_DOMAIN_V1 = "zyronchain/local-keystore/v1";
const KEYSTORE_DOMAIN_V2 = "zyronchain/local-keystore/v2";
const MAX_KEYSTORE_PASSWORD_BYTES = 1_024;

/** Legacy (v1) scrypt cost. Still accepted for decryption so existing keystores keep working. */
export const KEYSTORE_V1_SCRYPT = Object.freeze({ n: 32_768, r: 8, p: 1, dkLen: 32 });
/** Current (v2) scrypt cost: N = 2^17, r = 8, p = 1 (~128 MiB, a few hundred ms per unlock). */
export const KEYSTORE_V2_SCRYPT = Object.freeze({ n: 131_072, r: 8, p: 1, dkLen: 32 });
export const CURRENT_KEYSTORE_VERSION = 2;

interface ScryptParams { n: number; r: number; p: number; dkLen: number }

interface EncryptedKeystoreFields {
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  publicKey: string;
  address: string;
}

export interface EncryptedKeystoreV1 extends EncryptedKeystoreFields {
  version: 1;
}

export interface EncryptedKeystoreV2 extends EncryptedKeystoreFields {
  version: 2;
  kdfParams: { n: number; r: number; p: number; dkLen: number };
}

export type EncryptedKeystore = EncryptedKeystoreV1 | EncryptedKeystoreV2;

/** @internal Zeroize mutable secret bytes once their operation-scoped lifetime ends. */
export function zeroizeSecretBuffer(buffer: Buffer): void {
  buffer.fill(0);
}

/** Encrypts with the current keystore format (v2: scrypt N=2^17, r=8, p=1, AES-256-GCM). */
export function encryptPrivateKey(privateKey: string, password: string): EncryptedKeystoreV2 {
  assertPrivateKey(privateKey);
  assertPassword(password);
  const publicKey = publicKeyFromPrivate(privateKey);
  const address = addressFromPublicKey(publicKey);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt, KEYSTORE_V2_SCRYPT);
  const privateKeyBytes = Buffer.from(privateKey, "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(2, publicKey, address));
    const ciphertext = Buffer.concat([cipher.update(privateKeyBytes), cipher.final()]);
    return {
      version: 2,
      kdf: "scrypt",
      kdfParams: { ...KEYSTORE_V2_SCRYPT },
      cipher: "aes-256-gcm",
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
      publicKey,
      address
    };
  } finally {
    zeroizeSecretBuffer(privateKeyBytes);
    zeroizeSecretBuffer(key);
  }
}

export function decryptPrivateKey(value: unknown, password: string): string {
  assertPassword(password);
  const keystore = parseEncryptedKeystore(value);
  const params = keystore.version === 2 ? KEYSTORE_V2_SCRYPT : KEYSTORE_V1_SCRYPT;
  const key = deriveKey(password, Buffer.from(keystore.salt, "hex"), params);
  try {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(keystore.iv, "hex"));
      decipher.setAAD(aad(keystore.version, keystore.publicKey, keystore.address));
      decipher.setAuthTag(Buffer.from(keystore.tag, "hex"));
      const privateKeyBytes = Buffer.concat([
        decipher.update(Buffer.from(keystore.ciphertext, "hex")),
        decipher.final()
      ]);
      try {
        const privateKey = privateKeyBytes.toString("utf8");
        assertPrivateKey(privateKey);
        const publicKey = publicKeyFromPrivate(privateKey);
        if (publicKey !== keystore.publicKey || addressFromPublicKey(publicKey) !== keystore.address) {
          throw new Error("Encrypted keystore identity mismatch");
        }
        return privateKey;
      } finally {
        zeroizeSecretBuffer(privateKeyBytes);
      }
    } catch {
      throw new Error("Encrypted keystore authentication failed");
    }
  } finally {
    zeroizeSecretBuffer(key);
  }
}

export function isEncryptedKeystore(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    ((value as Record<string, unknown>).version === 1 || (value as Record<string, unknown>).version === 2) &&
    (value as Record<string, unknown>).kdf === "scrypt" &&
    (value as Record<string, unknown>).cipher === "aes-256-gcm";
}

/** Returns the keystore format version (1 legacy, 2 current) after strict validation. */
export function keystoreVersion(value: unknown): 1 | 2 {
  return parseEncryptedKeystore(value).version;
}

/**
 * Re-encrypts any supported keystore (v1 or v2) into the current v2 format with a fresh salt
 * and IV. The identity is verified during decryption, so a tampered source cannot migrate.
 */
export function migrateKeystore(value: unknown, password: string): EncryptedKeystoreV2 {
  const privateKey = decryptPrivateKey(value, password);
  return encryptPrivateKey(privateKey, password);
}

export function normalizePasswordFile(contents: string): string {
  if (Buffer.byteLength(contents, "utf8") > MAX_KEYSTORE_PASSWORD_BYTES) {
    throw new Error("Keystore password file is too large");
  }
  const password = contents.replace(/\r?\n$/, "");
  assertPassword(password);
  return password;
}

function parseEncryptedKeystore(value: unknown): EncryptedKeystore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Encrypted keystore is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) {
    throw new Error("Encrypted keystore algorithm is unsupported");
  }
  const expected = record.version === 2
    ? ["address", "cipher", "ciphertext", "iv", "kdf", "kdfParams", "publicKey", "salt", "tag", "version"]
    : ["address", "cipher", "ciphertext", "iv", "kdf", "publicKey", "salt", "tag", "version"];
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Encrypted keystore has unexpected fields");
  }
  if (record.kdf !== "scrypt" || record.cipher !== "aes-256-gcm") {
    throw new Error("Encrypted keystore algorithm is unsupported");
  }
  if (record.version === 2) assertV2KdfParams(record.kdfParams);
  assertHex(record.salt, 64, "salt");
  assertHex(record.iv, 24, "iv");
  assertHex(record.tag, 32, "tag");
  assertHex(record.ciphertext, 128, "ciphertext");
  if (typeof record.publicKey !== "string" || !/^[0-9a-f]{128}$/.test(record.publicKey)) {
    throw new Error("Encrypted keystore public key is invalid");
  }
  if (typeof record.address !== "string" || !/^ZYN[0-9a-f]{40}$/.test(record.address)) {
    throw new Error("Encrypted keystore address is invalid");
  }
  return record as unknown as EncryptedKeystore;
}

// v2 parameters are fixed by the version tag. Exact matching refuses both downgrades and
// attacker-chosen huge costs (memory/CPU exhaustion) before any scrypt work is done.
function assertV2KdfParams(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Encrypted keystore kdfParams are invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "dkLen,n,p,r" || record.n !== KEYSTORE_V2_SCRYPT.n || record.r !== KEYSTORE_V2_SCRYPT.r ||
      record.p !== KEYSTORE_V2_SCRYPT.p || record.dkLen !== KEYSTORE_V2_SCRYPT.dkLen) {
    throw new Error("Encrypted keystore kdfParams are unsupported");
  }
}

function deriveKey(password: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(password, salt, params.dkLen, {
    N: params.n,
    r: params.r,
    p: params.p,
    // scrypt needs 128 * N * r bytes; allow 2x headroom for the implementation.
    maxmem: 256 * params.n * params.r
  });
}

function aad(version: 1 | 2, publicKey: string, address: string): Buffer {
  if (version === 1) return Buffer.from(`${KEYSTORE_DOMAIN_V1}\n${publicKey}\n${address}`, "utf8");
  const { n, r, p, dkLen } = KEYSTORE_V2_SCRYPT;
  return Buffer.from(`${KEYSTORE_DOMAIN_V2}\nscrypt:n=${n},r=${r},p=${p},dklen=${dkLen}\n${publicKey}\n${address}`, "utf8");
}

function assertPrivateKey(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Private key is invalid");
  publicKeyFromPrivate(value);
}

function assertPassword(value: string): void {
  if (value.length < 12) throw new Error("Keystore password must contain at least 12 characters");
  if (Buffer.byteLength(value, "utf8") > MAX_KEYSTORE_PASSWORD_BYTES) {
    throw new Error("Keystore password is too large");
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("Keystore password contains forbidden characters");
  }
}

function assertHex(value: unknown, length: number, name: string): asserts value is string {
  if (typeof value !== "string" || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`Encrypted keystore ${name} is invalid`);
  }
}
